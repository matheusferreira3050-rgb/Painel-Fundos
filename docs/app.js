/* Painel de Fundos v2 — front-end estático (lê data/resumo.json e data/fundos/<chave>.json) */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const MAX_COMP = 5;
  const CORES = ["--s1", "--s2", "--s3", "--s4", "--s5"];

  const ler = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem storage */ } };

  const estado = {
    resumo: null, categoria: "Todas", distribuicao: "Todas", situacao: "Todas", busca: "",
    ordem: { col: "m12", asc: false }, cache: {}, sel: [], gu: ler("pf_gu", false),
  };

  // ------------------------------------------------------------ formatação
  const pct = (v, casas = 2) => v == null || !isFinite(v) ? "–" :
    (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%";
  const cls = (v) => v == null ? "nd" : v > 0 ? "pos" : v < 0 ? "neg" : "";
  const dataBR = (iso) => iso ? iso.slice(0, 10).split("-").reverse().join("/") : "–";
  const dinheiro = (v) => {
    if (v == null) return "–";
    const a = Math.abs(v), s = v < 0 ? "−" : "";
    if (a >= 1e9) return s + "R$ " + (a / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " bi";
    if (a >= 1e6) return s + "R$ " + (a / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (a >= 1e3) return s + "R$ " + (a / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
    return s + "R$ " + a.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const titulo = (s) => s ? String(s).toLowerCase().replace(/(^|\s|\/|-)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(S\.?a\.?|Ltda\.?|Dtvm|Cctvm|Fic|Fif|Fi|Rf|Cp|Ii|Iii)\b/gi, (m) => m.toUpperCase()) : "";
  const taxa = (v, inf) => v ? (/^[\d.,]+$/.test(v) ? Number(v.replace(",", ".")).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "% a.a." : v) + (inf ? ` (${inf})` : "") : null;
  const cor = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // ------------------------------------------------------------ gross-up
  const aliq = () => estado.resumo?.aliquota_grossup ?? 0.15;
  const usaGU = (f) => estado.gu && f.isento_ir;
  const gu = (f, v) => v == null ? null : usaGU(f) ? v / (1 - aliq()) : v;
  const ret = (f, k) => gu(f, f.ret?.[k]);
  const pctCDI = (f, k) => gu(f, f.pct_cdi?.[k]);

  // ------------------------------------------------------------ carga
  async function carregar() {
    try {
      const r = await fetch("data/resumo.json?v=" + Date.now());
      if (!r.ok) throw new Error(r.status);
      estado.resumo = await r.json();
    } catch (e) {
      $("#corpo").innerHTML = `<tr><td colspan="11" class="vazio">Os dados ainda não foram gerados. Rode o robô de atualização uma vez (aba Actions do GitHub).</td></tr>`;
      $("#carimbo").textContent = "";
      return;
    }
    const R = estado.resumo;
    document.title = R.titulo;
    $("#titulo").textContent = R.titulo;
    $("#subtitulo").textContent = R.subtitulo || "";
    $("#carimbo").innerHTML = `Cotas até <strong>${dataBR(R.data_base)}</strong><br>Atualizado em ${dataBR(R.atualizado_em)} ${R.atualizado_em.slice(11, 16)}`;
    const aq = (aliq() * 100).toLocaleString("pt-BR") + "%";
    $("#gu-aliq").textContent = `(IR ${aq})`;
    $$(".aliq-txt").forEach((e) => (e.textContent = aq));
    $("#gu").checked = estado.gu;
    if (!R.fundos.some((f) => f.isento_ir)) $(".chave-gu").hidden = true;
    estado.sel = ler("pf_sel", []).filter((k) => R.fundos.some((f) => f.chave === k && visivel(f)));
    montarChips();
    desenharTabela();
    desenharGestao();
    atualizarBarra();
    abrirPeloHash();
  }

  // ------------------------------------------------------------ abas
  $$(".aba").forEach((b) => b.addEventListener("click", () => {
    $$(".aba").forEach((x) => x.classList.toggle("ativa", x === b));
    $$(".painel").forEach((p) => p.classList.toggle("ativo", p.id === "aba-" + b.dataset.aba));
  }));

  // ------------------------------------------------------------ tabela principal
  const visivel = (f) => f.ativo && f.ultima_data && (f.status === "ok" || f.status === "defasado");
  const aberto = (f) => !f.status_comercial || /^ABERTO/i.test(f.status_comercial);
  const rotuloSit = (f) => {
    const s = (f.status_comercial || "").toUpperCase();
    if (!s || s === "ABERTO") return "";
    if (s.startsWith("ABERTO")) return s.split("|")[1]?.trim().toLowerCase() || "";
    return s === "FECHADO" ? "fechado p/ aplicação" : s.toLowerCase();
  };
  const visiveis = () => estado.resumo.fundos.filter(visivel);

  function montarChips() {
    const chips = (alvo, valores, atual, onClick) => {
      $(alvo).innerHTML = ["Todas", ...valores].map((c) => `<button class="chip${c === atual ? " ativo" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("");
      $$(alvo + " .chip").forEach((b) => b.addEventListener("click", () => { onClick(b.dataset.c); montarChips(); desenharTabela(); }));
    };
    const cats = [...new Set(visiveis().map((f) => f.categoria))];
    if (cats.length > 8) { // muitas categorias: lista suspensa
      const n = (c) => visiveis().filter((f) => f.categoria === c).length;
      $("#categorias").innerHTML = `<select class="seletor" aria-label="Categoria"><option value="Todas">Todas as categorias (${visiveis().length})</option>${cats.map((c) => `<option value="${esc(c)}"${c === estado.categoria ? " selected" : ""}>${esc(c)} (${n(c)})</option>`).join("")}</select>`;
      $("#categorias select").addEventListener("change", (e) => { estado.categoria = e.target.value; desenharTabela(); });
    } else chips("#categorias", cats, estado.categoria, (c) => (estado.categoria = c));
    const temSit = visiveis().some((f) => f.status_comercial);
    $("#grupo-sit").hidden = !temSit;
    if (temSit) chips("#situacoes", ["Abertos para aplicação", "Fechados para aplicação"], estado.situacao, (c) => (estado.situacao = c));
    const dists = [...new Set(visiveis().map((f) => f.distribuicao).filter(Boolean))];
    $("#grupo-dist").hidden = dists.length < 2;
    chips("#distribuicoes", dists, estado.distribuicao, (c) => (estado.distribuicao = c));
  }

  const valorCol = (f, col) => {
    switch (col) {
      case "nome": return f.nome.toLowerCase();
      case "pct12": return pctCDI(f, "m12");
      case "pctano": return pctCDI(f, "ano");
      case "vol12": return f.vol12;
      case "pl": return f.pl;
      default: return ret(f, col);
    }
  };

  function linhaCDI(lista) {
    const R = estado.resumo;
    let c, ate;
    if (R.cdi_ref) { c = R.cdi_ref.ret; ate = R.cdi_ref.data; }
    else { // versão antiga dos dados: usa o fundo com mais histórico
      const ref = [...lista].sort((a, b) => (a.inicio_historico > b.inicio_historico ? 1 : -1)).find((f) => f.cdi);
      if (!ref) return "";
      c = ref.cdi; ate = ref.ultima_data;
    }
    const cel = (v, n) => `<td class="${cls(v)}">${pct(v, n)}</td>`;
    return `<tr class="ref"><td class="txt fixa"><div class="cel-fundo"><span class="ck-vazio"></span><div><span class="nome-fundo">CDI</span><span class="meta-fundo">referência · até ${dataBR(ate)}</span></div></div></td>
      ${cel(c.dia, 3)}${cel(c.mes)}${cel(c.ano)}${cel(c.m12)}${cel(c.m24)}${cel(c.m36)}
      <td class="nd">100%</td><td class="nd">100%</td><td class="nd">–</td><td class="nd">–</td></tr>`;
  }

  function desenharTabela() {
    const q = estado.busca.trim().toLowerCase(), qd = q.replace(/\D/g, "");
    let lista = visiveis().filter((f) =>
      (estado.categoria === "Todas" || f.categoria === estado.categoria) &&
      (estado.distribuicao === "Todas" || f.distribuicao === estado.distribuicao) &&
      (estado.situacao === "Todas" || (estado.situacao === "Abertos para aplicação") === aberto(f)) &&
      (!q || f.nome.toLowerCase().includes(q) || (qd && f.cnpj.replace(/\D/g, "").includes(qd))));
    const { col, asc } = estado.ordem;
    lista.sort((a, b) => {
      const va = valorCol(a, col), vb = valorCol(b, col);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * (asc ? 1 : -1);
    });
    $$("#tabela th").forEach((th) => {
      th.classList.toggle("ordem", th.dataset.col === col);
      th.classList.toggle("asc", th.dataset.col === col && asc);
    });
    if (!lista.length) {
      $("#corpo").innerHTML = `<tr><td colspan="11" class="vazio">Nenhum fundo encontrado.</td></tr>`;
      return;
    }
    const cel = (f, v, n) => `<td class="${cls(v)}${usaGU(f) && v != null ? " gu" : ""}">${pct(v, n)}</td>`;
    $("#corpo").innerHTML = linhaCDI(lista) + lista.map((f) => {
      const marcado = estado.sel.includes(f.chave);
      const alerta = f.alertas?.some((a) => a.tipo !== "info");
      const sit = rotuloSit(f);
      const meta = [esc(f.categoria), f.distribuicao ? esc(f.distribuicao) : "", dataBR(f.ultima_data)].filter(Boolean).join(" · ") +
        (sit ? ` · <span class="${aberto(f) ? "tag-info" : "tag-fechado"}">${esc(sit)}</span>` : "");
      return `<tr data-chave="${esc(f.chave)}" class="${marcado ? "sel" : ""}">
        <td class="txt fixa"><div class="cel-fundo">
          <input type="checkbox" class="ck" aria-label="Comparar ${esc(f.nome)}" ${marcado ? "checked" : ""}>
          <div><button class="nome-fundo link">${esc(f.nome)}</button>
          <span class="meta-fundo">${meta}${f.isento_ir ? ' · <span class="tag-isento">isento IR</span>' : ""}${alerta ? ' · <span class="tag-alerta" title="Veja os alertas no detalhe">⚠ dados</span>' : ""}</span></div>
        </div></td>
        ${cel(f, ret(f, "dia"), 3)}${cel(f, ret(f, "mes"))}${cel(f, ret(f, "ano"))}${cel(f, ret(f, "m12"))}${cel(f, ret(f, "m24"))}${cel(f, ret(f, "m36"))}
        <td class="${usaGU(f) && pctCDI(f, "ano") != null ? "gu" : ""}">${pctCDI(f, "ano") == null ? '<span class="nd">–</span>' : pct(pctCDI(f, "ano"), 0)}</td>
        <td class="${usaGU(f) && pctCDI(f, "m12") != null ? "gu" : ""}">${pctCDI(f, "m12") == null ? '<span class="nd">–</span>' : pct(pctCDI(f, "m12"), 0)}</td>
        <td>${pct(f.vol12)}</td>
        <td>${dinheiro(f.pl)}</td>
      </tr>`;
    }).join("");
    $$("#corpo tr[data-chave]").forEach((tr) => {
      const ch = tr.dataset.chave;
      $(".ck", tr).addEventListener("change", (e) => alternarSel(ch, e.target));
      tr.addEventListener("click", (e) => {
        if (e.target.closest(".ck")) return;
        abrirFundo(ch);
      });
    });
    $("#nota-tabela").innerHTML = "Marque até 5 fundos para comparar. Toque no nome para ver o detalhe. Clique no cabeçalho para ordenar." +
      (estado.gu ? ` <span class="tag-gu">GU</span> = valor com gross-up (IR ${pct(aliq(), 0)}).` : "");
  }

  $$("#tabela th").forEach((th) => th.addEventListener("click", () => {
    const col = th.dataset.col;
    estado.ordem = estado.ordem.col === col ? { col, asc: !estado.ordem.asc } : { col, asc: col === "nome" };
    desenharTabela();
  }));
  $("#busca").addEventListener("input", (e) => { estado.busca = e.target.value; desenharTabela(); });
  $("#gu").addEventListener("change", (e) => { estado.gu = e.target.checked; gravar("pf_gu", estado.gu); desenharTabela(); });

  // ------------------------------------------------------------ seleção para comparar
  function alternarSel(ch, el) {
    const i = estado.sel.indexOf(ch);
    if (i >= 0) estado.sel.splice(i, 1);
    else if (estado.sel.length >= MAX_COMP) { el.checked = false; avisoRapido(`Você pode comparar até ${MAX_COMP} fundos.`); return; }
    else estado.sel.push(ch);
    gravar("pf_sel", estado.sel);
    el.closest("tr").classList.toggle("sel", estado.sel.includes(ch));
    atualizarBarra();
  }
  function atualizarBarra() {
    const n = estado.sel.length;
    $("#barra-comp").hidden = n === 0;
    $("#barra-txt").textContent = n === 1 ? "1 fundo selecionado — marque mais um" : `${n} fundos selecionados`;
    $("#abrir-comp").disabled = n < 2;
  }
  $("#limpar-comp").addEventListener("click", () => { estado.sel = []; gravar("pf_sel", []); atualizarBarra(); desenharTabela(); });
  $("#abrir-comp").addEventListener("click", () => abrirComparacao(estado.sel));

  function avisoRapido(txt) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = txt; t.classList.add("on");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2200);
  }

  // ------------------------------------------------------------ aba Fundos
  function desenharGestao() {
    const R = estado.resumo, repo = R.repo, br = R.branch || "main";
    const link = (href, txt, prim) => `<a class="botao${prim ? " primario" : ""}" href="${href}" target="_blank" rel="noopener"${repo ? "" : ' aria-disabled="true"'}>${txt}</a>`;
    if ($("#acoes-gestao")) $("#acoes-gestao").innerHTML = link(`https://github.com/${repo}/edit/${br}/fundos.yaml`, "Editar lista de fundos", true) + link(`https://github.com/${repo}/actions`, "Ver atualizações");
    $("#avisos").innerHTML = R.avisos?.length
      ? `<div class="alerta"><strong>Pontos de atenção na última atualização</strong><ul>${R.avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : "";
    const rot = { ok: "Atualizado", defasado: "Defasado", nao_encontrado: "Não encontrado", sem_dados_recentes: "Sem dados recentes" };
    $("#corpo-fundos").innerHTML = R.fundos.map((f) => {
      const st = f.ativo ? f.status : "inativo";
      return `<tr>
        <td class="txt">${esc(f.nome)}</td>
        <td class="txt mono">${esc(f.cnpj)}${f.subclasse ? `<br><span class="meta-fundo">subclasse ${esc(f.subclasse)}</span>` : ""}</td>
        <td class="txt">${esc(f.categoria)}</td>
        <td class="txt">${esc(f.distribuicao || "–")}</td>
        <td class="txt">${f.isento_ir ? "Isento" : "Tributado"}</td>
        <td class="txt"><span class="selo ${st}">${f.ativo ? rot[f.status] || f.status : "Oculto"}</span>${f.status_comercial ? `<br><span class="meta-fundo">plataforma: ${esc(f.status_comercial.toLowerCase())}</span>` : ""}</td>
        <td>${dataBR(f.ultima_data)}</td>
        <td>${dataBR(f.inicio_historico)}</td></tr>`;
    }).join("");
  }

  // ------------------------------------------------------------ painel lateral
  function abrirPainel(cab, hash) {
    $("#det-cab").innerHTML = cab;
    $("#det-corpo").innerHTML = '<div class="vazio">Carregando…</div>';
    $("#veu").hidden = false;
    $("#detalhe").hidden = false;
    $("#detalhe").scrollTop = 0;
    document.body.style.overflow = "hidden";
    history.replaceState(null, "", hash);
  }
  function fechar() {
    $("#veu").hidden = true;
    $("#detalhe").hidden = true;
    document.body.style.overflow = "";
    history.replaceState(null, "", location.pathname + location.search);
  }
  $("#fechar").addEventListener("click", fechar);
  $("#veu").addEventListener("click", fechar);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#detalhe").hidden) fechar(); });
  $("#copiar").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); avisoRapido("Link copiado"); }
    catch (e) { avisoRapido("Não foi possível copiar. Copie o endereço do navegador."); }
  });

  function abrirPeloHash() {
    const h = decodeURIComponent(location.hash);
    let m = h.match(/^#f=(.+)$/);
    if (m) return abrirFundo(m[1]);
    m = h.match(/^#c=(.+)$/);
    if (m) {
      const chs = m[1].split(",").filter((k) => estado.resumo.fundos.some((f) => f.chave === k && visivel(f))).slice(0, MAX_COMP);
      if (chs.length >= 2) abrirComparacao(chs);
    }
  }

  async function detalheDe(ch) {
    if (!estado.cache[ch]) {
      const r = await fetch(`data/fundos/${encodeURIComponent(ch)}.json?v=${estado.resumo.atualizado_em}`);
      if (!r.ok) throw new Error(r.status);
      estado.cache[ch] = await r.json();
    }
    return estado.cache[ch];
  }

  // ------------------------------------------------------------ detalhe de um fundo
  async function abrirFundo(ch) {
    const f = estado.resumo.fundos.find((x) => x.chave === ch);
    if (!f || !f.ultima_data) return;
    abrirPainel(`<div class="det-cat">${esc(f.categoria)}${f.distribuicao ? " · " + esc(f.distribuicao) : ""}${f.isento_ir ? ' · <span class="tag-isento">isento IR</span>' : ""}</div>
      <h2>${esc(f.nome)}</h2>
      <div class="det-cnpj">CNPJ ${esc(f.cnpj)}${f.subclasse ? " · subclasse " + esc(f.subclasse) : ""} · cota de ${dataBR(f.ultima_data)}</div>`,
      "#f=" + encodeURIComponent(ch));
    let det;
    try { det = await detalheDe(ch); } catch (e) { $("#det-corpo").innerHTML = '<div class="vazio">Não foi possível carregar o histórico.</div>'; return; }

    const kpi = (r, v, s, eh) => `<div class="kpi"><div class="r">${r}</div><div class="v ${typeof v === "number" ? cls(v) : ""}">${typeof v === "number" ? pct(v) : v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
    const pc = (k) => f.pct_cdi?.[k] != null ? pct(f.pct_cdi[k], 0) + " do CDI" : "";
    const cons = f.consistencia || {};
    const guTxt = f.isento_ir ? (k) => f.ret?.[k] != null ? `<br>GU: ${pct(f.ret[k] / (1 - aliq()))} · ${f.pct_cdi?.[k] != null ? pct(f.pct_cdi[k] / (1 - aliq()), 0) + " CDI" : ""}` : "" : () => "";
    const alertas = (f.alertas || []);
    const c = f.cadastro || {};
    const linhaCad = (r, v) => v ? `<div><dt>${r}</dt><dd>${esc(v)}</dd></div>` : "";
    const cadHtml = [
      linhaCad("Gestor", titulo(c.gestor)), linhaCad("Administrador", titulo(c.administrador)),
      linhaCad("Classificação ANBIMA", c.classificacao_anbima), linhaCad("Classe CVM", !c.classificacao_anbima ? c.classificacao : null),
      linhaCad("Taxa de administração", taxa(c.taxa_adm, c.inf_taxa_adm)), linhaCad("Taxa de performance", taxa(c.taxa_perf, c.inf_taxa_perf)),
      linhaCad("Resgate", c.resgate), linhaCad("Aplicação mínima", c.aplicacao_minima),
      linhaCad("Público-alvo", c.publico_alvo), linhaCad("Início", c.data_inicio ? dataBR(c.data_inicio) : null),
      linhaCad("Subclasse", c.subclasse_nome), linhaCad("Observação", c.observacao),
    ].join("");

    $("#det-corpo").innerHTML = `
      ${alertas.length ? `<div class="alertas-fundo">${alertas.map((a) => `<div class="al ${a.tipo}">${a.tipo === "info" ? "ⓘ" : "⚠"} ${esc(a.texto)}</div>`).join("")}</div>` : ""}
      <div class="kpis">
        ${kpi("No ano", f.ret.ano ?? "–", pc("ano") + guTxt("ano"))}
        ${kpi("12 meses", f.ret.m12 ?? "–", pc("m12") + guTxt("m12"))}
        ${kpi("24 meses", f.ret.m24 ?? "–", pc("m24") + guTxt("m24"))}
        ${kpi("Volatilidade 12m", f.vol12 != null ? pct(f.vol12) : "–", "anualizada")}
        ${kpi("Maior queda 12m", f.mdd12 != null ? pct(f.mdd12) : "–", "drawdown")}
        ${kpi("Meses ≥ CDI", cons.meses_avaliados ? `${cons.meses_acima_cdi}/${cons.meses_avaliados}` : "–", "últimos 24 meses")}
        ${kpi("Pior mês", cons.pior_mes ? cons.pior_mes.ret : "–", cons.pior_mes ? cons.pior_mes.ref : "")}
        ${kpi("Patrimônio", dinheiro(f.pl), f.cotistas != null ? f.cotistas.toLocaleString("pt-BR") + " cotistas" : "")}
        ${kpi("Captação líq. 30d", dinheiro(f.captacao_liquida_30d), "aplicações − resgates")}
      </div>
      <div class="grafico-cab">
        <div class="legenda"><span class="lg" style="background:var(--s1)"></span>Fundo <span class="lg tracejado"></span>CDI</div>
        <div class="periodos" id="periodos"></div>
      </div>
      <div class="grafico" id="grafico"></div>
      <p class="nota" id="nota-graf"></p>
      <h3>Patrimônio líquido</h3>
      <div class="grafico baixo" id="grafico-pl"></div>
      ${cadHtml ? `<h3>Informações do fundo</h3><dl class="cadastro">${cadHtml}</dl><p class="nota">Fonte: cadastro da CVM. Confira taxas, prazos de resgate e condições na lâmina e no regulamento.</p>` : ""}
      <h3>Rentabilidade mês a mês</h3>
      <p class="nota">Valor de cima: fundo. Valor de baixo: % do CDI no mês. “*” = ano incompleto.</p>
      <div class="tabela-wrap"><table class="mensal" id="mensal"></table></div>
      <h3>Rentabilidade diária — últimos 60 dias</h3>
      <p class="nota">Variação da cota em cada dia útil informado à CVM, comparada ao CDI do mesmo intervalo. Mais recente no topo.</p>
      <div class="tabela-wrap"><table class="diaria" id="diaria"></table></div>`;

    const d = det.serie;
    const linhas = (k0) => {
      const base = d.c[k0], ib = d.i?.[k0];
      const out = [{ nome: "Fundo", cor: "--s1", d: d.d.slice(k0), v: d.c.slice(k0).map((x) => x / base - 1) }];
      if (ib) out.push({ nome: "CDI", cor: "--cdi", tracejado: true, d: d.d.slice(k0), v: d.i.slice(k0).map((x) => (x == null ? null : x / ib - 1)) });
      return out;
    };
    montarPeriodos($("#periodos"), d.d[0], d.d[d.d.length - 1], (meses) => {
      const k0 = indiceBase(d.d, meses);
      graficoLinhas($("#grafico"), linhas(k0), { pct: true });
      $("#nota-graf").textContent = k0 > 0 && meses && lacunaNaBase(d.d, k0, alvoMeses(d.d, meses))
        ? `Sem cotas na CVM na data-base do período; o gráfico começa em ${dataBR(d.d[k0])}.` : "";
      const pl = d.pl.slice(k0);
      graficoLinhas($("#grafico-pl"), [{ nome: "PL", cor: "--s1", d: d.d.slice(k0), v: pl }], { dinheiro: true, area: true, altura: 150 });
    });
    desenharMensal($("#mensal"), det.mensal);
    desenharDiaria($("#diaria"), det.serie, 60);
  }

  // ------------------------------------------------------------ comparação
  async function abrirComparacao(chs) {
    const fundos = chs.map((k) => estado.resumo.fundos.find((f) => f.chave === k)).filter(Boolean);
    abrirPainel(`<div class="det-cat">Comparação</div><h2>${fundos.length} fundos lado a lado</h2>
      <div class="det-cnpj">Retorno acumulado no período, partindo da mesma data</div>`, "#c=" + chs.map(encodeURIComponent).join(","));
    let dets;
    try { dets = await Promise.all(chs.map(detalheDe)); } catch (e) { $("#det-corpo").innerHTML = '<div class="vazio">Não foi possível carregar os históricos.</div>'; return; }

    const inicioComum = dets.map((x) => x.serie.d[0]).sort().pop();
    const fimMax = dets.map((x) => x.serie.d[x.serie.d.length - 1]).sort().pop();
    const legenda = fundos.map((f, i) => `<span class="lg" style="background:var(${CORES[i]})"></span>${esc(f.nome)}`).join("");

    const linhaM = (rot, fn, fmt = (v) => pct(v), clsfn = cls) => `<tr><th>${rot}</th>${fundos.map((f) => { const v = fn(f); return `<td class="${typeof v === "number" ? clsfn(v) : ""}">${typeof v === "number" ? fmt(v) : (v ?? "–")}</td>`; }).join("")}</tr>`;
    const retG = (f, k) => ret(f, k);
    const tabela = `
      <table class="comp-tab">
        <thead><tr><th></th>${fundos.map((f, i) => `<th><span class="lg" style="background:var(${CORES[i]})"></span>${esc(f.nome)}${f.isento_ir ? '<br><span class="tag-isento">isento IR</span>' : ""}</th>`).join("")}</tr></thead>
        <tbody>
          <tr class="sec"><th colspan="${fundos.length + 1}">Rentabilidade${estado.gu ? ' <span class="tag-gu">GU</span> nos isentos' : ""}</th></tr>
          ${linhaM("Período do gráfico", (f) => f._retPeriodo)}
          ${linhaM("Mês", (f) => retG(f, "mes"))}
          ${linhaM("Ano", (f) => retG(f, "ano"))}
          ${linhaM("12 meses", (f) => retG(f, "m12"))}
          ${linhaM("24 meses", (f) => retG(f, "m24"))}
          ${linhaM("36 meses", (f) => retG(f, "m36"))}
          ${linhaM("% CDI 12 meses", (f) => pctCDI(f, "m12"), (v) => pct(v, 0), () => "")}
          ${linhaM("% CDI 24 meses", (f) => pctCDI(f, "m24"), (v) => pct(v, 0), () => "")}
          <tr class="sec"><th colspan="${fundos.length + 1}">Risco e consistência</th></tr>
          ${linhaM("Volatilidade 12m", (f) => f.vol12, (v) => pct(v), () => "")}
          ${linhaM("Maior queda 12m", (f) => f.mdd12, (v) => pct(v))}
          ${linhaM("Maior queda (histórico)", (f) => f.mdd_total, (v) => pct(v))}
          ${linhaM("Meses ≥ CDI (24m)", (f) => f.consistencia?.meses_avaliados ? `${f.consistencia.meses_acima_cdi}/${f.consistencia.meses_avaliados}` : null)}
          ${linhaM("Pior mês", (f) => f.consistencia?.pior_mes ? `${pct(f.consistencia.pior_mes.ret)} <small>${f.consistencia.pior_mes.ref}</small>` : null)}
          <tr class="sec"><th colspan="${fundos.length + 1}">Fundo</th></tr>
          ${linhaM("Patrimônio", (f) => dinheiro(f.pl))}
          ${linhaM("Captação líq. 30d", (f) => dinheiro(f.captacao_liquida_30d))}
          ${linhaM("Cotistas", (f) => f.cotistas?.toLocaleString("pt-BR"))}
          ${linhaM("Gestor", (f) => esc(titulo(f.cadastro?.gestor)) || null)}
          ${linhaM("Taxa de adm.", (f) => esc(taxa(f.cadastro?.taxa_adm)) || null)}
          ${linhaM("Resgate", (f) => esc(f.cadastro?.resgate) || null)}
          ${linhaM("Histórico desde", (f) => dataBR(f.inicio_historico))}
          ${linhaM("Última cota", (f) => dataBR(f.ultima_data))}
        </tbody>
      </table>`;

    $("#det-corpo").innerHTML = `
      <div class="grafico-cab"><div class="legenda multi">${legenda}<span class="lg tracejado"></span>CDI</div></div>
      <div class="grafico-cab direita"><div class="periodos" id="periodos"></div></div>
      <div class="grafico" id="grafico"></div>
      <p class="nota" id="nota-comp"></p>
      <div class="tabela-wrap">${tabela}</div>`;

    const desenhar = (meses) => {
      let corte = inicioComum;
      if (meses) {
        const c = new Date(fimMax); c.setMonth(c.getMonth() - meses);
        const ci = c.toISOString().slice(0, 10);
        if (ci > corte) corte = ci;
      }
      const linhas = dets.map((det, i) => {
        const d = det.serie, k0 = indiceDesde(d.d, corte), base = d.c[k0];
        fundos[i]._lacuna = lacunaNaBase(d.d, k0, corte) ? d.d[k0] : null;
        fundos[i]._retPeriodo = fundos[i]._lacuna ? null : gu(fundos[i], d.c[d.c.length - 1] / base - 1);
        return { nome: fundos[i].nome, cor: CORES[i], d: d.d.slice(k0), v: d.c.slice(k0).map((x) => gu(fundos[i], x / base - 1)) };
      });
      const refCDI = dets.find((x) => x.serie.i) ;
      if (refCDI) {
        const d = refCDI.serie, k0 = indiceDesde(d.d, corte), ib = d.i[k0];
        linhas.push({ nome: "CDI", cor: "--cdi", tracejado: true, d: d.d.slice(k0), v: d.i.slice(k0).map((x) => (x == null ? null : x / ib - 1)) });
      }
      graficoLinhas($("#grafico"), linhas, { pct: true });
      $("#nota-comp").textContent = `Base: ${dataBR(corte)}. ` + (corte === inicioComum && inicioComum > dets.map((x) => x.serie.d[0]).sort()[0]
        ? "O gráfico começa na data em que todos os fundos selecionados já tinham cota." : "") +
        (estado.gu && fundos.some((f) => f.isento_ir) ? " Fundos isentos exibidos com gross-up." : "") +
        fundos.filter((f) => f._lacuna).map((f) => ` ${f.nome}: sem cotas na CVM na data-base; a linha começa em ${dataBR(f._lacuna)} e o retorno do período não é comparável.`).join("");
      $$(".comp-tab tbody tr")[1].outerHTML = linhaM("Período do gráfico", (f) => f._retPeriodo);
    };
    montarPeriodos($("#periodos"), inicioComum, fimMax, desenhar);
  }

  // ------------------------------------------------------------ períodos
  const PERIODOS = [["6M", 6], ["1A", 12], ["2A", 24], ["3A", 36], ["5A", 60], ["Máx", 0]];
  function montarPeriodos(el, ini, fim, aoMudar) {
    const meses = (new Date(fim) - new Date(ini)) / (30.44 * 864e5);
    const padrao = meses >= 11.5 ? "1A" : "Máx";
    el.innerHTML = PERIODOS.map(([r, m]) => `<button data-m="${m}" ${m && m > meses + 0.5 ? "disabled" : ""} class="${r === padrao ? "ativo" : ""}">${r}</button>`).join("");
    $$("button", el).forEach((b) => b.addEventListener("click", () => {
      $$("button", el).forEach((x) => x.classList.toggle("ativo", x === b));
      aoMudar(+b.dataset.m);
    }));
    aoMudar(+$("button.ativo", el).dataset.m);
  }
  function alvoMeses(datas, meses) {
    const c = new Date(datas[datas.length - 1]); c.setMonth(c.getMonth() - meses);
    return c.toISOString().slice(0, 10);
  }
  function indiceBase(datas, meses) { return meses ? indiceDesde(datas, alvoMeses(datas, meses)) : 0; }
  function indiceDesde(datas, alvo) { // última data <= alvo; se ela for antiga demais (lacuna), a primeira depois
    let k = datas.findIndex((x) => x > alvo);
    if (k === -1) return datas.length - 1;
    if (k === 0) return 0;
    const ant = k - 1;
    return (Date.parse(alvo) - Date.parse(datas[ant])) / 864e5 > 7 ? k : ant;
  }
  const lacunaNaBase = (datas, k, alvo) => Date.parse(datas[k]) - Date.parse(alvo) > 7 * 864e5;

  // ------------------------------------------------------------ gráfico de linhas (SVG, eixo de tempo)
  function graficoLinhas(el, linhas, op = {}) {
    const W = Math.max(300, Math.min(860, el.clientWidth - 16 || 820));
    const H = op.altura || (W < 520 ? 240 : 300);
    const m = { t: 14, r: 12, b: 26, l: op.dinheiro ? 62 : 48 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const t = (s) => Date.parse(s);
    const t0 = Math.min(...linhas.map((l) => t(l.d[0]))), t1 = Math.max(...linhas.map((l) => t(l.d[l.d.length - 1])));
    const todos = linhas.flatMap((l) => l.v.filter((v) => v != null));
    if (!todos.length) { el.innerHTML = '<div class="vazio">Sem dados no período.</div>'; return; }
    let lo = Math.min(...todos), hi = Math.max(...todos);
    if (op.pct) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 0.01; lo -= pad; hi += pad;
    if (op.dinheiro && lo < 0) lo = 0;
    const x = (s) => m.l + (t1 === t0 ? 0 : ((t(s) - t0) / (t1 - t0)) * iw);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
    const salto = (l, k) => k && (t(l.d[k]) - t(l.d[k - 1])) > 10 * 864e5;
    const caminho = (l) => l.v.map((v, k) => v == null ? "" : `${k && l.v[k - 1] != null && !salto(l, k) ? "L" : "M"}${x(l.d[k]).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const fmtY = (v) => op.dinheiro ? dinheiro(v).replace("R$ ", "") : (Math.abs(v) < 1e-9 ? 0 : v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%";
    const passo = escolherPasso((hi - lo) / (H < 200 ? 3 : 5));
    let grade = "";
    for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo)
      grade += `<line class="grade" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="eixo" x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${fmtY(v)}</text>`;
    let rot = "";
    const n = W < 520 ? 3 : 5;
    for (let j = 0; j <= n; j++) {
      const dt = new Date(t0 + (j / n) * (t1 - t0));
      rot += `<text class="eixo" x="${m.l + (j / n) * iw}" y="${H - 6}" text-anchor="${j === 0 ? "start" : j === n ? "end" : "middle"}">${MESES[dt.getUTCMonth()]}/${String(dt.getUTCFullYear()).slice(2)}</text>`;
    }
    const zero = op.pct ? `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>` : "";
    const area = op.area ? linhas.map((l) => `<path d="${caminho(l)}L${x(l.d[l.d.length - 1])},${y(lo)}L${x(l.d[0])},${y(lo)}Z" fill="${cor(l.cor)}" opacity=".12"/>`).join("") : "";
    const paths = [...linhas].reverse().map((l) => `<path d="${caminho(l)}" fill="none" stroke="${cor(l.cor)}" stroke-width="${l.tracejado ? 1.5 : 2}" ${l.tracejado ? 'stroke-dasharray="5 4"' : ""}/>`).join("");
    const pontos = linhas.map((l, i) => `<circle class="pt" data-i="${i}" r="3.5" fill="${cor(l.cor)}" visibility="hidden"/>`).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico">${grade}${zero}${area}${paths}${rot}
      <line class="mira" y1="${m.t}" y2="${m.t + ih}" stroke="${cor("--suave")}" stroke-width="1" visibility="hidden"/>${pontos}
      <rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" class="area-toque"/></svg><div class="dica" hidden></div>`;

    const svg = $("svg", el), dica = $(".dica", el), mira = $(".mira", svg), pts = $$(".pt", svg);
    const perto = (l, ts) => { // índice mais próximo por busca binária
      let a = 0, b = l.d.length - 1;
      if (ts <= t(l.d[0])) return 0;
      if (ts >= t(l.d[b])) return b;
      while (b - a > 1) { const c = (a + b) >> 1; t(l.d[c]) <= ts ? (a = c) : (b = c); }
      return ts - t(l.d[a]) < t(l.d[b]) - ts ? a : b;
    };
    const mover = (ev) => {
      const p = ev.touches ? ev.touches[0] : ev;
      const r = svg.getBoundingClientRect();
      const sx = ((p.clientX - r.left) / r.width) * W;
      const ts = t0 + Math.max(0, Math.min(1, (sx - m.l) / iw)) * (t1 - t0);
      let linhasTxt = "", data = null, ymin = 1e9;
      linhas.forEach((l, i) => {
        const k = perto(l, ts), v = l.v[k];
        if (v == null || t(l.d[k]) < t(l.d[0])) { pts[i].setAttribute("visibility", "hidden"); return; }
        data = data || l.d[k];
        pts[i].setAttribute("cx", x(l.d[k])); pts[i].setAttribute("cy", y(v)); pts[i].setAttribute("visibility", "visible");
        ymin = Math.min(ymin, y(v));
        const nome = l.nome.length > 26 ? l.nome.slice(0, 25) + "…" : l.nome;
        linhasTxt += `<br><span style="color:${cor(l.cor)}">●</span> ${esc(nome)} ${op.dinheiro ? dinheiro(v) : pct(v)}`;
      });
      const X = x(new Date(ts).toISOString().slice(0, 10));
      mira.setAttribute("x1", X); mira.setAttribute("x2", X); mira.setAttribute("visibility", "visible");
      dica.hidden = false;
      dica.innerHTML = dataBR(data) + linhasTxt;
      const L = (X / W) * r.width;
      dica.style.left = Math.min(Math.max(L, 90), r.width - 90) + "px";
      dica.style.top = Math.max(0, (ymin / H) * r.height - 8) + "px";
    };
    const sair = () => { dica.hidden = true; mira.setAttribute("visibility", "hidden"); pts.forEach((p) => p.setAttribute("visibility", "hidden")); };
    const alvo = $(".area-toque", svg);
    alvo.addEventListener("mousemove", mover);
    alvo.addEventListener("touchstart", mover, { passive: true });
    alvo.addEventListener("touchmove", mover, { passive: true });
    alvo.addEventListener("mouseleave", sair);
    alvo.addEventListener("touchend", sair);
  }

  function escolherPasso(bruto) {
    if (!(bruto > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(bruto))), n = bruto / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  // ------------------------------------------------------------ tabela diária
  function desenharDiaria(el, d, n) {
    const ini = Math.max(1, d.d.length - n);
    const linhas = [];
    let acum = 1, acumCDI = 1;
    for (let k = ini; k < d.d.length; k++) {
      const r = d.c[k] / d.c[k - 1] - 1;
      const c = d.i && d.i[k] != null && d.i[k - 1] != null ? d.i[k] / d.i[k - 1] - 1 : null;
      const dias = (Date.parse(d.d[k]) - Date.parse(d.d[k - 1])) / 864e5;
      acum *= 1 + r; if (c != null) acumCDI *= 1 + c;
      linhas.push({ data: d.d[k], cota: d.c[k], r, c, pl: d.pl?.[k], lacuna: dias > 5 ? d.d[k - 1] : null, acum: acum - 1, acumCDI: acumCDI - 1 });
    }
    const cota = (v) => v.toLocaleString("pt-BR", { minimumFractionDigits: 6, maximumFractionDigits: 8 });
    el.innerHTML = `<thead><tr><th>Data</th><th>Cota</th><th>Fundo no dia</th><th>CDI no dia</th><th>% CDI</th><th>Fundo acum.</th><th>CDI acum.</th><th>PL</th></tr></thead><tbody>` +
      linhas.reverse().map((x) => `<tr>
        <td>${dataBR(x.data)}${x.lacuna ? `<span class="p">desde ${dataBR(x.lacuna)}</span>` : ""}</td>
        <td>${cota(x.cota)}</td>
        <td class="${cls(x.r)}">${pct(x.r, 4)}</td>
        <td>${pct(x.c, 4)}</td>
        <td>${x.c > 0 ? pct(x.r / x.c, 0) : "–"}</td>
        <td class="${cls(x.acum)}">${pct(x.acum)}</td>
        <td>${pct(x.acumCDI)}</td>
        <td>${dinheiro(x.pl)}</td></tr>`).join("") + "</tbody>";
  }

  // ------------------------------------------------------------ tabela mensal
  function desenharMensal(el, mensal) {
    const cab = `<thead><tr><th>Ano</th>${MESES.map((m) => `<th>${m}</th>`).join("")}<th>Ano</th></tr></thead>`;
    const linhas = mensal.map((a) => {
      const cel = (v, c) => v == null ? `<td class="nd">–</td>` :
        `<td><span class="${cls(v)}">${pct(v)}</span>${c != null && c > 0 ? `<span class="p">${pct(v / c, 0)}</span>` : ""}</td>`;
      const tot = a.fundo_ano == null ? `<td class="tot nd">–</td>` :
        `<td class="tot"><span class="${cls(a.fundo_ano)}">${pct(a.fundo_ano)}</span>${a.cdi_ano > 0 ? `<span class="p">${pct(a.fundo_ano / a.cdi_ano, 0)}</span>` : ""}</td>`;
      return `<tr><td>${a.ano}${a.parcial ? "*" : ""}</td>${a.fundo.map((v, k) => cel(v, a.cdi[k])).join("")}${tot}</tr>`;
    }).join("");
    el.innerHTML = cab + `<tbody>${linhas}</tbody>`;
  }

  window.addEventListener("hashchange", () => { if (!location.hash) fechar(); });
  carregar();
})();
