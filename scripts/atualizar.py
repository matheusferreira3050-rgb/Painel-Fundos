#!/usr/bin/env python3
"""
Robô de atualização do Painel de Fundos.

1. Lê a lista de fundos em fundos.yaml
2. Baixa os Informes Diários da CVM (dados.cvm.gov.br) e guarda só os CNPJs da lista
3. Baixa o CDI diário do Banco Central (SGS, série 12)
4. Calcula rentabilidades, %CDI, volatilidade e drawdown
5. Gera os JSONs que o site (pasta docs/) lê

Na primeira execução de cada fundo, baixa o histórico (anos_historico).
Nas execuções diárias, rebaixa só o mês atual e o anterior (a CVM aceita reenvios).
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import yaml

RAIZ = Path(__file__).resolve().parent.parent
ARQ_CONFIG = RAIZ / "fundos.yaml"
DIR_DADOS = RAIZ / "data"
ARQ_COTAS = DIR_DADOS / "cotas.csv"
ARQ_CDI = DIR_DADOS / "cdi.csv"
ARQ_ESTADO = DIR_DADOS / "estado.json"
DIR_SITE = RAIZ / "docs" / "data"

CVM_BASE = os.environ.get("CVM_BASE_URL", "https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS")
BCB_BASE = os.environ.get("BCB_BASE_URL", "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados")
FUSO_BR = timezone(timedelta(hours=-3))

SESSAO = requests.Session()
SESSAO.headers["User-Agent"] = "painel-fundos/1.0 (+github actions)"


def log(msg: str) -> None:
    print(f"[{datetime.now(FUSO_BR):%H:%M:%S}] {msg}", flush=True)


# --------------------------------------------------------------------------- utilidades
def so_digitos(cnpj: str) -> str:
    return re.sub(r"\D", "", str(cnpj)).zfill(14)


def formatar_cnpj(d: str) -> str:
    return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"


def chave_fundo(cnpj: str, subclasse: str | None) -> str:
    return so_digitos(cnpj) + (f"_{subclasse}" if subclasse else "")


def meses_entre(inicio: date, fim: date) -> list[tuple[int, int]]:
    out, a, m = [], inicio.year, inicio.month
    while (a, m) <= (fim.year, fim.month):
        out.append((a, m))
        m += 1
        if m == 13:
            a, m = a + 1, 1
    return out


def baixar(url: str, tentativas: int = 4) -> bytes | None:
    """Baixa um arquivo. Retorna None se não existir (404)."""
    for i in range(tentativas):
        try:
            r = SESSAO.get(url, timeout=180)
            if r.status_code == 404:
                return None
            r.raise_for_status()
            return r.content
        except requests.RequestException as e:
            espera = 5 * (i + 1)
            log(f"  falha ao baixar {url} ({e}); nova tentativa em {espera}s")
            time.sleep(espera)
    raise RuntimeError(f"Não foi possível baixar {url}")


# --------------------------------------------------------------------------- configuração
def ler_config() -> tuple[dict, list[dict]]:
    with open(ARQ_CONFIG, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    geral = cfg.get("configuracao", {}) or {}
    fundos = []
    vistos = set()
    for item in cfg.get("fundos", []) or []:
        if not item or not item.get("cnpj"):
            continue
        sub = str(item.get("subclasse") or "").strip() or None
        ch = chave_fundo(item["cnpj"], sub)
        if ch in vistos:
            log(f"AVISO: CNPJ repetido em fundos.yaml ignorado: {item['cnpj']}")
            continue
        vistos.add(ch)
        cnpj = so_digitos(item["cnpj"])
        fundos.append({
            "chave": ch,
            "cnpj": cnpj,
            "subclasse": sub,
            "nome": str(item.get("nome") or formatar_cnpj(cnpj)),
            "categoria": str(item.get("categoria") or "Outros"),
            "ativo": bool(item.get("ativo", True)),
        })
    return geral, fundos


# --------------------------------------------------------------------------- CVM
_cache_anual: dict[int, bytes | None] = {}


def _ler_csv_filtrado(conteudo, alvo: dict[str, list[dict]], filtro_mes: str | None) -> pd.DataFrame:
    """Lê um CSV do informe diário em pedaços e devolve só as linhas dos CNPJs pedidos."""
    cabecalho = conteudo.readline().decode("latin-1").strip().split(";")
    conteudo.seek(0)
    col_cnpj = "CNPJ_FUNDO_CLASSE" if "CNPJ_FUNDO_CLASSE" in cabecalho else "CNPJ_FUNDO"
    tem_sub = "ID_SUBCLASSE" in cabecalho
    usar = [c for c in (col_cnpj, "ID_SUBCLASSE", "DT_COMPTC", "VL_QUOTA", "VL_PATRIM_LIQ",
                        "CAPTC_DIA", "RESG_DIA", "NR_COTST") if c in cabecalho]
    cnpjs_alvo = set(alvo)
    partes = []
    for bloco in pd.read_csv(conteudo, sep=";", encoding="latin-1", dtype=str,
                             usecols=usar, chunksize=400_000):
        bloco["cnpj"] = bloco[col_cnpj].str.replace(r"\D", "", regex=True).str.zfill(14)
        bloco = bloco[bloco["cnpj"].isin(cnpjs_alvo)]
        if filtro_mes:
            bloco = bloco[bloco["DT_COMPTC"].str.startswith(filtro_mes)]
        if not bloco.empty:
            partes.append(bloco)
    if not partes:
        return pd.DataFrame()
    df = pd.concat(partes, ignore_index=True)
    df["sub"] = df["ID_SUBCLASSE"].fillna("").str.strip() if tem_sub else ""
    return df


def _escolher_linhas(df: pd.DataFrame, alvo: dict[str, list[dict]], avisos: list[str]) -> pd.DataFrame:
    """Para cada fundo configurado, separa as linhas certas (classe ou subclasse)."""
    saida = []
    for cnpj, fundos in alvo.items():
        linhas = df[df["cnpj"] == cnpj]
        if linhas.empty:
            continue
        for f in fundos:
            if f["subclasse"]:
                sel = linhas[linhas["sub"] == f["subclasse"]]
            else:
                sel = linhas[linhas["sub"] == ""]
                if sel.empty:
                    subs = sorted(linhas["sub"].unique())
                    sel = linhas[linhas["sub"] == subs[0]]
                    msg = (f"{f['nome']} ({formatar_cnpj(cnpj)}) tem subclasses na CVM {subs}; "
                           f"usando '{subs[0]}'. Defina 'subclasse' no fundos.yaml para escolher.")
                    if msg not in avisos:
                        avisos.append(msg)
            if sel.empty:
                continue
            sel = sel.assign(chave=f["chave"])
            saida.append(sel)
    if not saida:
        return pd.DataFrame()
    out = pd.concat(saida, ignore_index=True)
    num = lambda s: pd.to_numeric(s, errors="coerce")
    res = pd.DataFrame({
        "chave": out["chave"],
        "data": pd.to_datetime(out["DT_COMPTC"], errors="coerce").dt.strftime("%Y-%m-%d"),
        "cota": num(out["VL_QUOTA"]),
        "pl": num(out.get("VL_PATRIM_LIQ")),
        "cotistas": num(out.get("NR_COTST")),
        "captacao": num(out.get("CAPTC_DIA")),
        "resgate": num(out.get("RESG_DIA")),
    })
    res = res.dropna(subset=["data", "cota"])
    res = res[res["cota"] > 0]
    return res.drop_duplicates(subset=["chave", "data"], keep="last")


def baixar_mes(ano: int, mes: int, alvo: dict[str, list[dict]], avisos: list[str]) -> pd.DataFrame | None:
    """Devolve as linhas do mês para os fundos alvo. None = arquivo do mês não existe."""
    ref = f"{ano}{mes:02d}"
    url = f"{CVM_BASE}/inf_diario_fi_{ref}.zip"
    log(f"Baixando informe diário {mes:02d}/{ano}")
    dados = baixar(url)
    filtro = None
    if dados is None:
        # meses antigos ficam agrupados por ano na pasta HIST
        if ano not in _cache_anual:
            log(f"  mensal não encontrado; tentando arquivo anual {ano} (HIST)")
            _cache_anual[ano] = baixar(f"{CVM_BASE}/HIST/inf_diario_fi_{ano}.zip")
        dados = _cache_anual[ano]
        if dados is None:
            log(f"  {mes:02d}/{ano} indisponível na CVM")
            return None
        filtro = f"{ano}-{mes:02d}"

    partes = []
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        nomes = [n for n in z.namelist() if n.lower().endswith(".csv")]
        do_mes = [n for n in nomes if ref in n]
        for n in (do_mes or nomes):
            with z.open(n) as bruto, tempfile.TemporaryFile() as tmp:
                tmp.write(bruto.read())
                tmp.seek(0)
                df = _ler_csv_filtrado(tmp, alvo, filtro)
                if not df.empty:
                    partes.append(df)
    if not partes:
        return pd.DataFrame(columns=["chave", "data", "cota", "pl", "cotistas", "captacao", "resgate"])
    return _escolher_linhas(pd.concat(partes, ignore_index=True), alvo, avisos)


def atualizar_cotas(fundos: list[dict], anos: int, hoje: date, avisos: list[str]) -> pd.DataFrame:
    if ARQ_COTAS.exists():
        cotas = pd.read_csv(ARQ_COTAS, dtype={"chave": str})
    else:
        cotas = pd.DataFrame(columns=["chave", "data", "cota", "pl", "cotistas", "captacao", "resgate"])
    estado = json.loads(ARQ_ESTADO.read_text()) if ARQ_ESTADO.exists() else {}
    backfill = estado.setdefault("historico_desde", {})

    inicio_desejado = date(hoje.year - anos, hoje.month, 1)
    recentes = meses_entre(date(hoje.year, hoje.month, 1) - timedelta(days=1), hoje)
    recentes = [m for m in recentes][-2:]  # mês anterior + mês atual

    # Quais meses cada fundo precisa
    precisa: dict[tuple[int, int], list[dict]] = {}
    for f in fundos:
        desde = backfill.get(f["chave"])
        if desde is None or desde > inicio_desejado.isoformat():
            fim_hist = date.fromisoformat(desde) - timedelta(days=1) if desde else hoje
            for m in meses_entre(inicio_desejado, fim_hist):
                precisa.setdefault(m, []).append(f)
        for m in recentes:
            precisa.setdefault(m, [])
            if f not in precisa[m]:
                precisa[m].append(f)

    novos = []
    for (ano, mes) in sorted(precisa):
        lista = precisa[(ano, mes)]
        if not lista:
            continue
        alvo: dict[str, list[dict]] = {}
        for f in lista:
            alvo.setdefault(f["cnpj"], []).append(f)
        df = baixar_mes(ano, mes, alvo, avisos)
        if df is None:
            continue
        # substitui o mês inteiro desses fundos (trata reenvios/retificações)
        chaves = {f["chave"] for f in lista}
        pref = f"{ano}-{mes:02d}"
        manter = ~(cotas["chave"].isin(chaves) & cotas["data"].astype(str).str.startswith(pref))
        cotas = cotas[manter]
        novos.append(df)

    if novos:
        cotas = pd.concat([cotas, *novos], ignore_index=True)
    cotas = cotas.drop_duplicates(subset=["chave", "data"], keep="last").sort_values(["chave", "data"])

    for f in fundos:
        atual = backfill.get(f["chave"])
        if atual is None or atual > inicio_desejado.isoformat():
            backfill[f["chave"]] = inicio_desejado.isoformat()

    DIR_DADOS.mkdir(exist_ok=True)
    cotas.to_csv(ARQ_COTAS, index=False)
    ARQ_ESTADO.write_text(json.dumps(estado, indent=2, ensure_ascii=False))
    log(f"Base de cotas: {len(cotas):,} linhas".replace(",", "."))
    return cotas


# --------------------------------------------------------------------------- CDI
def atualizar_cdi(inicio: date, hoje: date, avisos: list[str]) -> pd.DataFrame:
    cdi = pd.read_csv(ARQ_CDI) if ARQ_CDI.exists() else pd.DataFrame(columns=["data", "taxa"])
    if not cdi.empty and cdi["data"].min() <= inicio.isoformat():
        desde = date.fromisoformat(cdi["data"].max()) - timedelta(days=10)
    else:
        desde = inicio - timedelta(days=10)
        cdi = cdi.iloc[0:0]
    try:
        partes = []
        a = desde
        while a <= hoje:  # a API limita a janela a 10 anos
            b = min(a + timedelta(days=365 * 9), hoje)
            url = f"{BCB_BASE}?formato=json&dataInicial={a:%d/%m/%Y}&dataFinal={b:%d/%m/%Y}"
            log(f"Baixando CDI {a:%d/%m/%Y} a {b:%d/%m/%Y}")
            bruto = baixar(url)
            if bruto:
                j = json.loads(bruto)
                partes.append(pd.DataFrame({
                    "data": pd.to_datetime([x["data"] for x in j], format="%d/%m/%Y").strftime("%Y-%m-%d"),
                    "taxa": [float(x["valor"]) for x in j],
                }))
            a = b + timedelta(days=1)
        if partes:
            cdi = pd.concat([cdi, *partes]).drop_duplicates("data", keep="last").sort_values("data")
            cdi.to_csv(ARQ_CDI, index=False)
    except Exception as e:  # CDI é complementar: o painel funciona sem ele
        avisos.append(f"Não foi possível atualizar o CDI hoje ({e}). Usando a última base salva.")
    return cdi


def indice_cdi(cdi: pd.DataFrame) -> pd.Series:
    """Índice acumulado: I(t) = produto de (1+taxa) dos dias úteis ANTERIORES a t.
    A taxa do dia d remunera de d para d+1, que é o que a cota de d+1 já incorpora."""
    if cdi.empty:
        return pd.Series(dtype=float)
    s = cdi.set_index(pd.to_datetime(cdi["data"]))["taxa"].astype(float) / 100
    idx = (1 + s).cumprod().shift(1).fillna(1.0)
    # um dia a mais para cobrir a cota do dia seguinte ao último CDI publicado
    proximo = idx.index[-1] + pd.offsets.BDay(1)
    idx.loc[proximo] = idx.iloc[-1] * (1 + s.iloc[-1])
    return idx


# --------------------------------------------------------------------------- métricas
JANELAS = {"m6": 6, "m12": 12, "m24": 24, "m36": 36, "m60": 60}


def _base_em(serie: pd.Series, quando: pd.Timestamp) -> float | None:
    antes = serie[serie.index <= quando]
    return None if antes.empty else float(antes.iloc[-1])


def _r(x: float | None) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), 8)


def calcular(serie: pd.Series, idx: pd.Series) -> dict:
    """serie: cota indexada por data. idx: índice CDI. Retorna janelas de retorno."""
    fim = serie.index[-1]
    ult = float(serie.iloc[-1])
    cdi_em = (lambda d: float(idx[idx.index <= d].iloc[-1]) if not idx.empty and (idx.index <= d).any() else None)
    cdi_fim = cdi_em(fim)

    bases: dict[str, pd.Timestamp | None] = {}
    bases["dia"] = serie.index[-2] if len(serie) > 1 else None
    bases["mes"] = pd.Timestamp(fim.year, fim.month, 1) - pd.Timedelta(days=1)
    bases["ano"] = pd.Timestamp(fim.year - 1, 12, 31)
    for k, n in JANELAS.items():
        bases[k] = fim - pd.DateOffset(months=n)
    bases["inicio"] = serie.index[0]

    ret, cdi, pct = {}, {}, {}
    for k, b in bases.items():
        if b is None or b < serie.index[0] - pd.Timedelta(days=5):
            ret[k] = cdi[k] = pct[k] = None
            continue
        dt_base = serie[serie.index <= b].index[-1] if (serie.index <= b).any() else serie.index[0]
        v0 = float(serie.loc[dt_base])
        ret[k] = ult / v0 - 1
        c0 = cdi_em(dt_base)
        cdi[k] = (cdi_fim / c0 - 1) if (c0 and cdi_fim) else None
        pct[k] = (ret[k] / cdi[k]) if (cdi[k] and cdi[k] > 0) else None
    return {"ret": {k: _r(v) for k, v in ret.items()},
            "cdi": {k: _r(v) for k, v in cdi.items()},
            "pct_cdi": {k: _r(v) for k, v in pct.items()}}


def risco(serie: pd.Series) -> dict:
    fim = serie.index[-1]
    j12 = serie[serie.index >= fim - pd.DateOffset(months=12)]
    r = np.log(j12).diff().dropna()
    vol = float(r.std() * np.sqrt(252)) if len(r) > 20 else None
    dd = lambda s: float((s / s.cummax() - 1).min()) if len(s) > 1 else None
    return {"vol12": _r(vol), "mdd12": _r(dd(j12)), "mdd_total": _r(dd(serie)),
            "dd_atual": _r(float(serie.iloc[-1] / serie.max() - 1))}


def tabela_mensal(serie: pd.Series, idx: pd.Series) -> list[dict]:
    fim_mes = serie.groupby([serie.index.year, serie.index.month]).tail(1)
    datas = list(fim_mes.index)
    cdi_em = (lambda d: float(idx[idx.index <= d].iloc[-1]) if not idx.empty and (idx.index <= d).any() else None)
    anos: dict[int, dict] = {}
    base_dt, base_v = serie.index[0], float(serie.iloc[0])
    primeiro = True
    for d in datas:
        v = float(fim_mes.loc[d])
        a = anos.setdefault(d.year, {"ano": d.year, "fundo": [None] * 12, "cdi": [None] * 12})
        if not primeiro or base_dt < d:
            a["fundo"][d.month - 1] = _r(v / base_v - 1)
            c0, c1 = cdi_em(base_dt), cdi_em(d)
            a["cdi"][d.month - 1] = _r(c1 / c0 - 1) if c0 and c1 else None
        primeiro = False
        base_dt, base_v = d, v
    # total do ano
    for ano, a in anos.items():
        prev = serie[serie.index <= pd.Timestamp(ano - 1, 12, 31)]
        ini_dt = prev.index[-1] if not prev.empty else serie.index[0]
        ini_v = float(serie.loc[ini_dt])
        do_ano = serie[serie.index.year == ano]
        a["fundo_ano"] = _r(float(do_ano.iloc[-1]) / ini_v - 1)
        c0, c1 = cdi_em(ini_dt), cdi_em(do_ano.index[-1])
        a["cdi_ano"] = _r(c1 / c0 - 1) if c0 and c1 else None
        a["parcial"] = prev.empty
    return sorted(anos.values(), key=lambda x: -x["ano"])


# --------------------------------------------------------------------------- saída
def gerar_site(geral: dict, fundos: list[dict], cotas: pd.DataFrame, cdi: pd.DataFrame,
               hoje: date, avisos: list[str]) -> None:
    (DIR_SITE / "fundos").mkdir(parents=True, exist_ok=True)
    idx = indice_cdi(cdi)
    limite_defasagem = int(geral.get("dias_alerta_defasagem", 7))
    resumo_fundos = []
    chaves_validas = set()

    for f in fundos:
        dados = cotas[cotas["chave"] == f["chave"]].copy()
        item = {
            "chave": f["chave"], "cnpj": formatar_cnpj(f["cnpj"]), "subclasse": f["subclasse"],
            "nome": f["nome"], "categoria": f["categoria"], "ativo": f["ativo"],
        }
        if dados.empty:
            item["status"] = "nao_encontrado"
            avisos.append(f"{f['nome']} ({item['cnpj']}): CNPJ não encontrado nos informes diários da CVM.")
            resumo_fundos.append(item)
            continue

        dados["data"] = pd.to_datetime(dados["data"])
        dados = dados.set_index("data").sort_index()
        serie = dados["cota"].astype(float)
        ultima = serie.index[-1]
        atraso = (pd.Timestamp(hoje) - ultima).days
        item["status"] = "defasado" if atraso > limite_defasagem else "ok"
        if item["status"] == "defasado":
            avisos.append(f"{f['nome']}: última cota em {ultima:%d/%m/%Y} ({atraso} dias atrás).")

        u30 = dados[dados.index > ultima - pd.Timedelta(days=30)]
        item.update({
            "ultima_data": ultima.strftime("%Y-%m-%d"),
            "inicio_historico": serie.index[0].strftime("%Y-%m-%d"),
            "cota": float(serie.iloc[-1]),
            "pl": _r(dados["pl"].iloc[-1]),
            "cotistas": None if pd.isna(dados["cotistas"].iloc[-1]) else int(dados["cotistas"].iloc[-1]),
            "captacao_liquida_30d": _r(float((u30["captacao"].fillna(0) - u30["resgate"].fillna(0)).sum())),
            **calcular(serie, idx),
            **risco(serie),
        })
        resumo_fundos.append(item)
        chaves_validas.add(f["chave"])

        cdi_alinhado = idx.reindex(idx.index.union(serie.index)).ffill().reindex(serie.index) if not idx.empty else None
        detalhe = {
            "chave": f["chave"],
            "serie": {
                "d": [d.strftime("%Y-%m-%d") for d in serie.index],
                "c": [round(float(v), 8) for v in serie.values],
                "i": None if cdi_alinhado is None else [None if pd.isna(v) else round(float(v), 10) for v in cdi_alinhado.values],
                "pl": [None if pd.isna(v) else round(float(v), 2) for v in dados["pl"].values],
            },
            "mensal": tabela_mensal(serie, idx),
        }
        (DIR_SITE / "fundos" / f"{f['chave']}.json").write_text(
            json.dumps(detalhe, ensure_ascii=False, separators=(",", ":")))

    # remove arquivos de fundos que saíram da lista
    for arq in (DIR_SITE / "fundos").glob("*.json"):
        if arq.stem not in chaves_validas:
            arq.unlink()

    datas = [x["ultima_data"] for x in resumo_fundos if x.get("ultima_data") and x["ativo"]]
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    resumo = {
        "titulo": geral.get("titulo", "Painel de Fundos"),
        "subtitulo": geral.get("subtitulo", ""),
        "atualizado_em": datetime.now(FUSO_BR).isoformat(timespec="minutes"),
        "data_base": max(datas) if datas else None,
        "cdi_ultima_data": None if cdi.empty else cdi["data"].max(),
        "repo": repo,
        "branch": os.environ.get("GITHUB_REF_NAME", "main"),
        "fundos": resumo_fundos,
        "avisos": avisos,
    }
    (DIR_SITE / "resumo.json").write_text(json.dumps(resumo, ensure_ascii=False, indent=1))
    log(f"Site atualizado: {len(chaves_validas)} fundos com dados, {len(avisos)} aviso(s)")


def main() -> int:
    hoje = datetime.now(FUSO_BR).date()
    if os.environ.get("DATA_HOJE"):  # útil para testes
        hoje = date.fromisoformat(os.environ["DATA_HOJE"])
    geral, fundos = ler_config()
    if not fundos:
        log("Nenhum fundo em fundos.yaml")
        return 1
    anos = int(geral.get("anos_historico", 5))
    avisos: list[str] = []
    cotas = atualizar_cotas(fundos, anos, hoje, avisos)
    cdi = atualizar_cdi(date(hoje.year - anos, hoje.month, 1), hoje, avisos)
    gerar_site(geral, fundos, cotas, cdi, hoje, avisos)
    for a in avisos:
        log(f"AVISO: {a}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
