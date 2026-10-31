#!/usr/bin/env python3
"""
Robô de atualização do Painel de Fundos (v2).

1. Lê a lista de fundos em fundos.yaml
2. Baixa o cadastro da CVM (gestor, administrador, subclasses, classificação ANBIMA, taxas)
3. Baixa os Informes Diários da CVM e guarda só os CNPJs da lista
4. Baixa o CDI diário do Banco Central (SGS, série 12)
5. Calcula rentabilidades, %CDI, gross-up de isentos, risco, consistência
6. Verifica a qualidade dos dados (lacunas, cotas paradas, movimentos atípicos)
7. Gera os JSONs que o site (pasta docs/) lê
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
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
ARQ_CADASTRO = DIR_DADOS / "cadastro.json"
DIR_SITE = RAIZ / "docs" / "data"

CVM_BASE = os.environ.get("CVM_BASE_URL", "https://dados.cvm.gov.br/dados/FI/DOC/INF_DIARIO/DADOS")
CVM_CAD = os.environ.get("CVM_CAD_URL", "https://dados.cvm.gov.br/dados/FI/CAD/DADOS")
BCB_BASE = os.environ.get("BCB_BASE_URL", "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados")
FUSO_BR = timezone(timedelta(hours=-3))

TOLERANCIA_BASE_DIAS = 7      # base de cálculo pode estar até N dias antes da data ideal
LACUNA_DIAS = 10              # intervalo sem cotas (dias corridos) considerado lacuna
SEM_DADOS_RECENTES_DIAS = 30  # acima disso o fundo sai da tabela principal

SESSAO = requests.Session()
SESSAO.headers["User-Agent"] = "painel-fundos/2.0 (+github actions)"


def log(msg: str) -> None:
    print(f"[{datetime.now(FUSO_BR):%H:%M:%S}] {msg}", flush=True)


# --------------------------------------------------------------------------- utilidades
def so_digitos(cnpj) -> str:
    return re.sub(r"\D", "", str(cnpj)).zfill(14)


def formatar_cnpj(d: str) -> str:
    return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}"


def chave_fundo(cnpj: str, subclasse: str | None) -> str:
    return so_digitos(cnpj) + (f"_{subclasse}" if subclasse else "")


def normalizar(txt: str) -> str:
    t = unicodedata.normalize("NFKD", str(txt)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", t.lower())


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


def _r(x) -> float | None:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return round(x, 8) if np.isfinite(x) else None


def dbr(d) -> str:
    return pd.Timestamp(d).strftime("%d/%m/%Y")


# --------------------------------------------------------------------------- configuração
def ler_config() -> tuple[dict, list[dict]]:
    with open(ARQ_CONFIG, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    geral = cfg.get("configuracao", {}) or {}
    fundos, vistos = [], set()
    for item in cfg.get("fundos", []) or []:
        if not item or not item.get("cnpj"):
            continue
        sub = str(item.get("subclasse") or "").strip() or None
        cnpj = so_digitos(item["cnpj"])
        ch = chave_fundo(cnpj, sub)
        if ch in vistos:
            log(f"AVISO: CNPJ repetido em fundos.yaml ignorado: {item['cnpj']}")
            continue
        vistos.add(ch)
        txt = lambda k: (str(item.get(k)).strip() if item.get(k) not in (None, "") else None)
        fundos.append({
            "chave": ch, "cnpj": cnpj, "subclasse": sub, "sub_efetiva": sub,
            "nome": str(item.get("nome") or formatar_cnpj(cnpj)),
            "categoria": str(item.get("categoria") or "Outros"),
            "distribuicao": txt("distribuicao"),
            "ativo": bool(item.get("ativo", True)),
            "isento_ir": bool(item.get("isento_ir", False)),
            "manual": {k: txt(k) for k in ("gestor", "taxa_adm", "taxa_perf", "resgate",
                                          "aplicacao_minima", "observacao")},
        })
    return geral, fundos


# --------------------------------------------------------------------------- cadastro CVM
def _col(df: pd.DataFrame, *nomes: str, contem: str | None = None) -> str | None:
    norm = {normalizar(c): c for c in df.columns}
    for n in nomes:
        if normalizar(n) in norm:
            return norm[normalizar(n)]
    if contem:
        for k, c in norm.items():
            if contem in k:
                return c
    return None


def _ler_csv_zip(z: zipfile.ZipFile, trecho: str) -> pd.DataFrame | None:
    nomes = [n for n in z.namelist() if trecho in n.lower() and n.lower().endswith(".csv")]
    if not nomes:
        return None
    with z.open(nomes[0]) as f:
        return pd.read_csv(f, sep=";", encoding="latin-1", dtype=str, on_bad_lines="skip")


def atualizar_cadastro(fundos: list[dict], hoje: date, avisos: list[str]) -> dict:
    """Retorna {cnpj: {...dados..., 'subclasses': [{id, nome}]}}. Usa cache de até 6 dias."""
    cache = json.loads(ARQ_CADASTRO.read_text()) if ARQ_CADASTRO.exists() else {}
    alvo = {f["cnpj"] for f in fundos}
    if cache.get("data") and (hoje - date.fromisoformat(cache["data"])).days < 6 \
            and alvo <= set(cache.get("fundos", {})):
        return cache["fundos"]

    out: dict[str, dict] = {c: {"subclasses": []} for c in alvo}
    try:
        log("Baixando cadastro da CVM (fundos, classes e subclasses)")
        bruto = baixar(f"{CVM_CAD}/registro_fundo_classe.zip")
        if bruto:
            with zipfile.ZipFile(io.BytesIO(bruto)) as z:
                rf = _ler_csv_zip(z, "registro_fundo")
                rc = _ler_csv_zip(z, "registro_classe")
                rs = _ler_csv_zip(z, "registro_subclasse")
            if rc is not None:
                c_cnpj = _col(rc, "CNPJ_Classe", contem="cnpjclasse")
                c_idc = _col(rc, "ID_Registro_Classe", contem="idregistroclasse")
                c_idf = _col(rc, "ID_Registro_Fundo", contem="idregistrofundo")
                rc["_cnpj"] = rc[c_cnpj].map(so_digitos)
                rc = rc[rc["_cnpj"].isin(alvo)]
                pega = {
                    "denominacao": _col(rc, "Denominacao_Social"),
                    "classificacao_anbima": _col(rc, "Classificacao_Anbima", contem="anbima"),
                    "classificacao": _col(rc, "Classificacao"),
                    "publico_alvo": _col(rc, "Publico_Alvo", contem="publicoalvo"),
                    "data_inicio": _col(rc, "Data_Inicio", "Data_Constituicao"),
                    "situacao": _col(rc, "Situacao"),
                    "tributacao_lp": _col(rc, "Tributacao_Longo_Prazo", contem="tributacao"),
                    "condominio": _col(rc, "Forma_Condominio", contem="condominio"),
                }
                fundo_por_id = {}
                if rf is not None and c_idf:
                    f_id = _col(rf, "ID_Registro_Fundo", contem="idregistrofundo")
                    f_gest = _col(rf, "Gestor")
                    f_adm = _col(rf, "Administrador")
                    for _, l in rf.iterrows():
                        fundo_por_id[l.get(f_id)] = {"gestor": l.get(f_gest) if f_gest else None,
                                                     "administrador": l.get(f_adm) if f_adm else None}
                id_para_cnpj = {}
                for _, l in rc.iterrows():
                    d = out[l["_cnpj"]]
                    for k, c in pega.items():
                        if c and pd.notna(l.get(c)) and str(l.get(c)).strip():
                            d[k] = str(l[c]).strip()
                    if c_idf and l.get(c_idf) in fundo_por_id:
                        for k, v in fundo_por_id[l[c_idf]].items():
                            if v and pd.notna(v):
                                d[k] = str(v).strip()
                    if c_idc:
                        id_para_cnpj[l[c_idc]] = l["_cnpj"]
                if rs is not None and id_para_cnpj:
                    s_idc = _col(rs, "ID_Registro_Classe", contem="idregistroclasse")
                    s_id = _col(rs, "ID_Subclasse", contem="idsubclasse")
                    s_nome = _col(rs, "Denominacao_Social", contem="denominacao")
                    s_sit = _col(rs, "Situacao")
                    for _, l in rs[rs[s_idc].isin(id_para_cnpj)].iterrows():
                        out[id_para_cnpj[l[s_idc]]]["subclasses"].append({
                            "id": str(l[s_id]).strip(),
                            "nome": str(l.get(s_nome) or "").strip(),
                            "situacao": str(l.get(s_sit) or "").strip() if s_sit else "",
                        })
        # Cadastro antigo (ICVM 555): traz taxa de administração/performance quando existir
        bruto = baixar(f"{CVM_CAD}/cad_fi.csv")
        if bruto:
            cf = pd.read_csv(io.BytesIO(bruto), sep=";", encoding="latin-1", dtype=str, on_bad_lines="skip")
            c_cnpj = _col(cf, "CNPJ_FUNDO")
            cf["_cnpj"] = cf[c_cnpj].map(so_digitos)
            cf = cf[cf["_cnpj"].isin(alvo)]
            c_sit = _col(cf, "SIT")
            if c_sit:
                cf = cf.sort_values(c_sit, key=lambda s: s.str.contains("FUNCIONAMENTO", na=False))
            for _, l in cf.iterrows():
                d = out[l["_cnpj"]]
                for k, c in (("taxa_adm", "TAXA_ADM"), ("taxa_perf", "TAXA_PERFM"),
                             ("gestor", "GESTOR"), ("administrador", "ADMIN"),
                             ("classificacao", "CLASSE"), ("publico_alvo", "PUBLICO_ALVO")):
                    col = _col(cf, c)
                    v = l.get(col) if col else None
                    if v is not None and pd.notna(v) and str(v).strip() and k not in d:
                        d[k] = str(v).strip()
                for k, c in (("inf_taxa_adm", "INF_TAXA_ADM"), ("inf_taxa_perf", "INF_TAXA_PERFM")):
                    col = _col(cf, c)
                    v = l.get(col) if col else None
                    if v is not None and pd.notna(v) and str(v).strip():
                        d[k] = str(v).strip()
        DIR_DADOS.mkdir(exist_ok=True)
        ARQ_CADASTRO.write_text(json.dumps({"data": hoje.isoformat(), "fundos": out},
                                           ensure_ascii=False, indent=1))
        return out
    except Exception as e:  # cadastro é complementar
        avisos.append(f"Não foi possível atualizar o cadastro da CVM hoje ({e}). Usando o último salvo.")
        return cache.get("fundos", out)


def resolver_subclasses(fundos: list[dict], cad: dict, avisos: list[str]) -> None:
    """Escolhe a subclasse quando o CNPJ tem mais de uma e o fundos.yaml não definiu."""
    for f in fundos:
        subs = cad.get(f["cnpj"], {}).get("subclasses") or []
        if f["subclasse"] or not subs:
            continue
        m = re.search(r"subclasse\s+([\w-]+)", f["nome"], re.I)
        escolhida = None
        if m:
            alvo = normalizar("subclasse" + m.group(1))
            cand = [s for s in subs if normalizar(s["nome"]).endswith(alvo)]
            if len(cand) == 1:
                escolhida = cand[0]
        if escolhida:
            f["sub_efetiva"] = escolhida["id"]
            f["sub_nome"] = escolhida["nome"]
        elif len(subs) > 1:
            lista = "; ".join(f"{s['id']} = {s['nome']}" for s in subs)
            avisos.append(f"{f['nome']} ({formatar_cnpj(f['cnpj'])}) tem {len(subs)} subclasses na CVM: "
                          f"{lista}. Coloque o código certo no campo 'subclasse' do fundos.yaml.")


# --------------------------------------------------------------------------- informes diários
_cache_anual: dict[int, bytes | None] = {}


def _ler_csv_filtrado(conteudo, alvo: dict, filtro_mes: str | None) -> pd.DataFrame:
    cabecalho = conteudo.readline().decode("latin-1").strip().split(";")
    conteudo.seek(0)
    col_cnpj = "CNPJ_FUNDO_CLASSE" if "CNPJ_FUNDO_CLASSE" in cabecalho else "CNPJ_FUNDO"
    tem_sub = "ID_SUBCLASSE" in cabecalho
    usar = [c for c in (col_cnpj, "ID_SUBCLASSE", "DT_COMPTC", "VL_QUOTA", "VL_PATRIM_LIQ",
                        "CAPTC_DIA", "RESG_DIA", "NR_COTST") if c in cabecalho]
    partes = []
    for bloco in pd.read_csv(conteudo, sep=";", encoding="latin-1", dtype=str,
                             usecols=usar, chunksize=400_000):
        bloco["cnpj"] = bloco[col_cnpj].str.replace(r"\D", "", regex=True).str.zfill(14)
        bloco = bloco[bloco["cnpj"].isin(set(alvo))]
        if filtro_mes:
            bloco = bloco[bloco["DT_COMPTC"].str.startswith(filtro_mes)]
        if not bloco.empty:
            partes.append(bloco)
    if not partes:
        return pd.DataFrame()
    df = pd.concat(partes, ignore_index=True)
    df["sub"] = df["ID_SUBCLASSE"].fillna("").str.strip() if tem_sub else ""
    return df


def _escolher_linhas(df: pd.DataFrame, alvo: dict, avisos: list[str]) -> pd.DataFrame:
    saida = []
    for cnpj, fundos in alvo.items():
        linhas = df[df["cnpj"] == cnpj]
        if linhas.empty:
            continue
        for f in fundos:
            if f["sub_efetiva"]:
                sel = linhas[linhas["sub"] == f["sub_efetiva"]]
            else:
                sel = linhas[linhas["sub"] == ""]
                if sel.empty:
                    subs = sorted(linhas["sub"].unique())
                    sel = linhas[linhas["sub"] == subs[0]]
                    if len(subs) > 1 and not any(f["nome"] in a for a in avisos):
                        avisos.append(f"{f['nome']} ({formatar_cnpj(cnpj)}) tem subclasses {subs} nos "
                                      f"informes; usando '{subs[0]}'. Defina 'subclasse' no fundos.yaml.")
            if sel.empty:
                continue
            saida.append(sel.assign(chave=f["chave"]))
    if not saida:
        return pd.DataFrame()
    out = pd.concat(saida, ignore_index=True)
    num = lambda c: pd.to_numeric(out[c], errors="coerce") if c in out else np.nan
    res = pd.DataFrame({
        "chave": out["chave"],
        "data": pd.to_datetime(out["DT_COMPTC"], errors="coerce").dt.strftime("%Y-%m-%d"),
        "cota": num("VL_QUOTA"), "pl": num("VL_PATRIM_LIQ"), "cotistas": num("NR_COTST"),
        "captacao": num("CAPTC_DIA"), "resgate": num("RESG_DIA"),
    })
    res = res.dropna(subset=["data", "cota"])
    res = res[res["cota"] > 0]
    return res.drop_duplicates(subset=["chave", "data"], keep="last")


def baixar_mes(ano: int, mes: int, alvo: dict, avisos: list[str]) -> pd.DataFrame | None:
    ref = f"{ano}{mes:02d}"
    log(f"Baixando informe diário {mes:02d}/{ano}")
    dados = baixar(f"{CVM_BASE}/inf_diario_fi_{ref}.zip")
    filtro = None
    if dados is None:
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
        for n in ([n for n in nomes if ref in n] or nomes):
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
    selecao = estado.setdefault("subclasse_usada", {})

    # Se a subclasse escolhida mudou, o histórico daquele fundo é baixado de novo
    for f in fundos:
        usada = f["sub_efetiva"] or ""
        anterior = selecao.get(f["chave"], "?" if usada else "")
        if anterior != usada:
            log(f"Subclasse de {f['nome']} mudou ({anterior or 'padrão'} → {usada}); rebaixando histórico")
            cotas = cotas[cotas["chave"] != f["chave"]]
            backfill.pop(f["chave"], None)
        selecao[f["chave"]] = usada

    inicio_desejado = date(hoje.year - anos, hoje.month, 1)
    recentes = meses_entre(date(hoje.year, hoje.month, 1) - timedelta(days=1), hoje)[-2:]

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
        chaves = {f["chave"] for f in lista}
        pref = f"{ano}-{mes:02d}"
        cotas = cotas[~(cotas["chave"].isin(chaves) & cotas["data"].astype(str).str.startswith(pref))]
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
    if not cdi.empty and cdi["data"].min() <= (inicio + timedelta(days=10)).isoformat():
        desde = date.fromisoformat(cdi["data"].max()) - timedelta(days=10)
    else:
        desde = inicio - timedelta(days=10)
        cdi = cdi.iloc[0:0]
    try:
        partes, a = [], desde
        while a <= hoje:
            b = min(a + timedelta(days=365 * 9), hoje)
            log(f"Baixando CDI {a:%d/%m/%Y} a {b:%d/%m/%Y}")
            bruto = baixar(f"{BCB_BASE}?formato=json&dataInicial={a:%d/%m/%Y}&dataFinal={b:%d/%m/%Y}")
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
    except Exception as e:
        avisos.append(f"Não foi possível atualizar o CDI hoje ({e}). Usando a última base salva.")
    return cdi


def indice_cdi(cdi: pd.DataFrame) -> pd.Series:
    """I(t) = produto de (1+taxa) dos dias úteis ANTERIORES a t (a taxa de d remunera d→d+1)."""
    if cdi.empty:
        return pd.Series(dtype=float)
    s = cdi.set_index(pd.to_datetime(cdi["data"]))["taxa"].astype(float) / 100
    idx = (1 + s).cumprod().shift(1).fillna(1.0)
    idx.loc[idx.index[-1] + pd.offsets.BDay(1)] = idx.iloc[-1] * (1 + s.iloc[-1])
    return idx


# --------------------------------------------------------------------------- métricas
JANELAS = {"m6": 6, "m12": 12, "m24": 24, "m36": 36, "m60": 60}


class Calc:
    def __init__(self, serie: pd.Series, idx: pd.Series):
        self.s = serie
        self.idx = idx

    def cdi_em(self, d):
        if self.idx.empty or not (self.idx.index <= d).any():
            return None
        return float(self.idx[self.idx.index <= d].iloc[-1])

    def base(self, alvo: pd.Timestamp):
        """Última cota em até TOLERANCIA dias antes de 'alvo'. None se não houver (lacuna)."""
        s = self.s
        if alvo < s.index[0] - pd.Timedelta(days=5):
            return None
        antes = s[s.index <= alvo]
        if antes.empty:
            return s.index[0] if (s.index[0] - alvo).days <= 5 else None
        dt = antes.index[-1]
        return dt if (alvo - dt).days <= TOLERANCIA_BASE_DIAS else None

    def janela(self, dt_base) -> tuple:
        if dt_base is None:
            return None, None
        fim = self.s.index[-1]
        r = float(self.s.iloc[-1]) / float(self.s.loc[dt_base]) - 1
        c0, c1 = self.cdi_em(dt_base), self.cdi_em(fim)
        return r, ((c1 / c0 - 1) if c0 and c1 else None)


def calcular(serie: pd.Series, idx: pd.Series) -> dict:
    k = Calc(serie, idx)
    fim = serie.index[-1]
    bases = {
        "dia": serie.index[-2] if len(serie) > 1 and (fim - serie.index[-2]).days <= 5 else None,
        "mes": k.base(pd.Timestamp(fim.year, fim.month, 1) - pd.Timedelta(days=1)),
        "ano": k.base(pd.Timestamp(fim.year - 1, 12, 31)),
        **{j: k.base(fim - pd.DateOffset(months=n)) for j, n in JANELAS.items()},
        "inicio": serie.index[0],
    }
    ret, cdi, pct = {}, {}, {}
    for j, b in bases.items():
        r, c = k.janela(b)
        ret[j], cdi[j] = r, c
        pct[j] = (r / c) if (r is not None and c and c > 0) else None
    return {"ret": {a: _r(v) for a, v in ret.items()},
            "cdi": {a: _r(v) for a, v in cdi.items()},
            "pct_cdi": {a: _r(v) for a, v in pct.items()}}


def risco(serie: pd.Series) -> dict:
    fim = serie.index[-1]
    j12 = serie[serie.index >= fim - pd.DateOffset(months=12)]
    r = np.log(j12).diff().dropna()
    vol = float(r.std() * np.sqrt(252)) if len(r) > 20 else None
    dd = lambda s: float((s / s.cummax() - 1).min()) if len(s) > 1 else None
    return {"vol12": _r(vol), "mdd12": _r(dd(j12)), "mdd_total": _r(dd(serie)),
            "dd_atual": _r(float(serie.iloc[-1] / serie.max() - 1))}


def tabela_mensal(serie: pd.Series, idx: pd.Series) -> list[dict]:
    k = Calc(serie, idx)
    anos: dict[int, dict] = {}
    for per in pd.period_range(serie.index[0], serie.index[-1], freq="M"):
        a = anos.setdefault(per.year, {"ano": per.year, "fundo": [None] * 12, "cdi": [None] * 12})
        fim_mes = serie[(serie.index >= per.start_time) & (serie.index <= per.end_time)]
        if fim_mes.empty:
            continue
        d1 = fim_mes.index[-1]
        ultimo_mes = (per.year, per.month) == (serie.index[-1].year, serie.index[-1].month)
        if not ultimo_mes and (per.end_time - d1).days > TOLERANCIA_BASE_DIAS:
            continue  # mês sem cotas até o fim (lacuna): não dá para medir
        d0 = k.base(per.start_time - pd.Timedelta(days=1))
        if d0 is None or d0 >= d1:
            continue
        a["fundo"][per.month - 1] = _r(float(serie.loc[d1]) / float(serie.loc[d0]) - 1)
        c0, c1 = k.cdi_em(d0), k.cdi_em(d1)
        a["cdi"][per.month - 1] = _r(c1 / c0 - 1) if c0 and c1 else None
    for ano, a in anos.items():
        do_ano = serie[serie.index.year == ano]
        if ano < serie.index[-1].year and (pd.Timestamp(ano, 12, 31) - do_ano.index[-1]).days > TOLERANCIA_BASE_DIAS:
            a["parcial"], a["fundo_ano"], a["cdi_ano"] = True, None, None
            continue
        d0 = k.base(pd.Timestamp(ano - 1, 12, 31))
        a["parcial"] = d0 is None
        if d0 is None:  # ano incompleto: acumula os meses válidos, se não houver buraco
            d0 = do_ano.index[0] if None not in a["fundo"][do_ano.index[0].month:do_ano.index[-1].month] else None
        if d0 is None:
            a["fundo_ano"] = a["cdi_ano"] = None
            continue
        a["fundo_ano"] = _r(float(do_ano.iloc[-1]) / float(serie.loc[d0]) - 1)
        c0, c1 = k.cdi_em(d0), k.cdi_em(do_ano.index[-1])
        a["cdi_ano"] = _r(c1 / c0 - 1) if c0 and c1 else None
    return sorted(anos.values(), key=lambda x: -x["ano"])


def consistencia(mensal: list[dict], ultima: pd.Timestamp) -> dict:
    meses = []
    for a in mensal:
        for m in range(12):
            if a["fundo"][m] is not None:
                meses.append((a["ano"], m + 1, a["fundo"][m], a["cdi"][m]))
    meses.sort()
    # descarta o mês corrente (incompleto)
    meses = [x for x in meses if (x[0], x[1]) != (ultima.year, ultima.month)]
    u24 = meses[-24:]
    validos = [x for x in u24 if x[3] is not None]
    acima = sum(1 for x in validos if x[2] >= x[3])
    pior = min(meses, key=lambda x: x[2]) if meses else None
    return {
        "meses_acima_cdi": acima, "meses_avaliados": len(validos),
        "pior_mes": None if not pior else {"ref": f"{pior[1]:02d}/{pior[0]}", "ret": pior[2]},
        "meses_negativos": sum(1 for x in meses if x[2] < 0), "meses_total": len(meses),
    }


# --------------------------------------------------------------------------- qualidade
def lacunas(serie: pd.Series) -> list[dict]:
    d = serie.index.to_series().diff().dt.days
    out = []
    for fim, dias in d[d > LACUNA_DIAS].items():
        ini = serie.index[serie.index.get_loc(fim) - 1]
        out.append({"de": ini.strftime("%Y-%m-%d"), "ate": fim.strftime("%Y-%m-%d"), "dias": int(dias)})
    return out


def movimentos_atipicos(series: dict[str, pd.Series]) -> dict[str, list[dict]]:
    """Retornos diários fora do padrão do próprio fundo. Classifica como 'mercado' quando
    outros fundos da lista se moveram forte no mesmo sentido no mesmo dia."""
    rets = {}
    for ch, s in series.items():
        r = s.pct_change()
        gap = s.index.to_series().diff().dt.days > 5  # retorno que atravessa lacuna não conta
        rets[ch] = r[~gap].dropna()
    painel = pd.DataFrame(rets)
    out: dict[str, list[dict]] = {}
    for ch, r in rets.items():
        if len(r) < 30:
            continue
        mad = (r - r.median()).abs().median() * 1.4826
        limite = max(8 * mad, 0.01)
        for dt, v in r[(r - r.median()).abs() > limite].items():
            dia = painel.loc[dt].drop(ch).dropna()
            juntos = int(((dia * np.sign(v)) > 0.005).sum())
            out.setdefault(ch, []).append({
                "data": dt.strftime("%Y-%m-%d"), "ret": _r(v), "outros_fundos": juntos,
                "tipo": "mercado" if juntos >= 2 else "isolado",
            })
    return out


# --------------------------------------------------------------------------- saída
def gerar_site(geral: dict, fundos: list[dict], cotas: pd.DataFrame, cdi: pd.DataFrame,
               cad: dict, hoje: date, avisos: list[str]) -> None:
    (DIR_SITE / "fundos").mkdir(parents=True, exist_ok=True)
    idx = indice_cdi(cdi)
    limite_defasagem = int(geral.get("dias_alerta_defasagem", 7))
    aliquota = float(geral.get("aliquota_grossup", 0.15))
    resumo_fundos, chaves_validas, series = [], set(), {}

    for f in fundos:
        dados = cotas[cotas["chave"] == f["chave"]].copy()
        if dados.empty:
            continue
        dados["data"] = pd.to_datetime(dados["data"])
        dados = dados.set_index("data").sort_index()
        series[f["chave"]] = dados
    atipicos = movimentos_atipicos({k: v["cota"].astype(float) for k, v in series.items()})
    corte_aviso = pd.Timestamp(hoje) - pd.Timedelta(days=60)

    for f in fundos:
        c = cad.get(f["cnpj"], {})
        info = {k: v for k, v in c.items() if k != "subclasses" and v}
        info.update({k: v for k, v in f["manual"].items() if v})  # o que está no yaml prevalece
        if f.get("sub_nome"):
            info["subclasse_nome"] = f["sub_nome"]
        item = {
            "chave": f["chave"], "cnpj": formatar_cnpj(f["cnpj"]),
            "subclasse": f["sub_efetiva"], "nome": f["nome"], "categoria": f["categoria"],
            "distribuicao": f["distribuicao"], "ativo": f["ativo"], "isento_ir": f["isento_ir"],
            "cadastro": info, "alertas": [],
        }
        if f["chave"] not in series:
            item["status"] = "nao_encontrado"
            item["alertas"].append({"tipo": "erro", "texto": "CNPJ não encontrado nos informes diários da CVM."})
            avisos.append(f"{f['nome']} ({item['cnpj']}): CNPJ não encontrado nos informes diários da CVM.")
            resumo_fundos.append(item)
            continue

        dados = series[f["chave"]]
        serie = dados["cota"].astype(float)
        ultima = serie.index[-1]
        atraso = (pd.Timestamp(hoje) - ultima).days
        if atraso > SEM_DADOS_RECENTES_DIAS:
            item["status"] = "sem_dados_recentes"
            txt = f"Sem cotas na CVM desde {dbr(ultima)}. O fundo pode ter sido encerrado, incorporado ou mudado de CNPJ."
            item["alertas"].append({"tipo": "erro", "texto": txt})
            avisos.append(f"{f['nome']}: {txt}")
        elif atraso > limite_defasagem:
            item["status"] = "defasado"
            item["alertas"].append({"tipo": "atencao", "texto": f"Última cota em {dbr(ultima)} ({atraso} dias)."})
            avisos.append(f"{f['nome']}: última cota em {dbr(ultima)} ({atraso} dias atrás).")
        else:
            item["status"] = "ok"

        lac = lacunas(serie)
        for g in lac:
            txt = (f"Sem cotas na CVM entre {dbr(g['de'])} e {dbr(g['ate'])} ({g['dias']} dias). "
                   f"Períodos que dependem dessas datas aparecem como “–”.")
            item["alertas"].append({"tipo": "atencao", "texto": txt})
            if pd.Timestamp(g["ate"]) >= ultima - pd.DateOffset(months=36):
                avisos.append(f"{f['nome']}: {txt}")
        eventos = atipicos.get(f["chave"], [])
        for ev in eventos:
            if pd.Timestamp(ev["data"]) < corte_aviso:
                continue
            if ev["tipo"] == "isolado":
                txt = (f"Variação atípica de {ev['ret']*100:+.2f}% em {dbr(ev['data'])}, "
                       f"sem movimento parecido nos demais fundos. Vale conferir com o gestor/administrador.")
                item["alertas"].append({"tipo": "atencao", "texto": txt})
                avisos.append(f"{f['nome']}: {txt}")
            else:
                item["alertas"].append({"tipo": "info", "texto":
                    f"Variação de {ev['ret']*100:+.2f}% em {dbr(ev['data'])}, junto com outros "
                    f"{ev['outros_fundos']} fundos da lista (movimento de mercado)."})

        u30 = dados[dados.index > ultima - pd.Timedelta(days=30)]
        mensal = tabela_mensal(serie, idx)
        item.update({
            "ultima_data": ultima.strftime("%Y-%m-%d"),
            "inicio_historico": serie.index[0].strftime("%Y-%m-%d"),
            "cota": float(serie.iloc[-1]),
            "pl": _r(dados["pl"].iloc[-1]),
            "cotistas": None if pd.isna(dados["cotistas"].iloc[-1]) else int(dados["cotistas"].iloc[-1]),
            "captacao_liquida_30d": _r(float((u30["captacao"].fillna(0) - u30["resgate"].fillna(0)).sum())),
            **calcular(serie, idx), **risco(serie),
            "consistencia": consistencia(mensal, ultima),
            "lacunas": lac,
        })
        resumo_fundos.append(item)
        chaves_validas.add(f["chave"])

        cdi_al = idx.reindex(idx.index.union(serie.index)).ffill().reindex(serie.index) if not idx.empty else None
        detalhe = {
            "chave": f["chave"],
            "serie": {
                "d": [d.strftime("%Y-%m-%d") for d in serie.index],
                "c": [round(float(v), 8) for v in serie.values],
                "i": None if cdi_al is None else [None if pd.isna(v) else round(float(v), 10) for v in cdi_al.values],
                "pl": [None if pd.isna(v) else round(float(v), 2) for v in dados["pl"].values],
                "cap": [_r(a - b) for a, b in zip(dados["captacao"].fillna(0), dados["resgate"].fillna(0))],
            },
            "mensal": mensal,
            "eventos": eventos,
        }
        (DIR_SITE / "fundos" / f"{f['chave']}.json").write_text(
            json.dumps(detalhe, ensure_ascii=False, separators=(",", ":")))

    for arq in (DIR_SITE / "fundos").glob("*.json"):
        if arq.stem not in chaves_validas:
            arq.unlink()

    datas = [x["ultima_data"] for x in resumo_fundos if x.get("status") in ("ok", "defasado") and x["ativo"]]
    resumo = {
        "titulo": geral.get("titulo", "Painel de Fundos"),
        "subtitulo": geral.get("subtitulo", ""),
        "atualizado_em": datetime.now(FUSO_BR).isoformat(timespec="minutes"),
        "data_base": max(datas) if datas else None,
        "cdi_ultima_data": None if cdi.empty else cdi["data"].max(),
        "aliquota_grossup": aliquota,
        "repo": os.environ.get("GITHUB_REPOSITORY", ""),
        "branch": os.environ.get("GITHUB_REF_NAME", "main"),
        "fundos": resumo_fundos,
        "avisos": avisos,
    }
    (DIR_SITE / "resumo.json").write_text(json.dumps(resumo, ensure_ascii=False, indent=1))
    log(f"Site atualizado: {len(chaves_validas)} fundos com dados, {len(avisos)} aviso(s)")


def main() -> int:
    hoje = datetime.now(FUSO_BR).date()
    if os.environ.get("DATA_HOJE"):
        hoje = date.fromisoformat(os.environ["DATA_HOJE"])
    geral, fundos = ler_config()
    if not fundos:
        log("Nenhum fundo em fundos.yaml")
        return 1
    anos = int(geral.get("anos_historico", 5))
    avisos: list[str] = []
    cad = atualizar_cadastro(fundos, hoje, avisos)
    resolver_subclasses(fundos, cad, avisos)
    cotas = atualizar_cotas(fundos, anos, hoje, avisos)
    cdi = atualizar_cdi(date(hoje.year - anos, hoje.month, 1), hoje, avisos)
    gerar_site(geral, fundos, cotas, cdi, cad, hoje, avisos)
    for a in avisos:
        log(f"AVISO: {a}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
