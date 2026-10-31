/* Painel de Fundos — front-end estático (lê data/resumo.json e data/fundos/<chave>.json) */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

  const estado = { resumo: null, categoria: "Todas", busca: "", ordem: { col: "m12", asc: false }, cache: {} };

  // ------------------------------------------------------------ formatação
  const pct = (v, casas = 2) => v == null ? "–" :
    (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%";
  const cls = (v) => v == null ? "nd" : v > 0 ? "pos" : v < 0 ? "neg" : "";
  const celPct = (v, casas) => `<td class="${cls(v)}">${pct(v, casas)}</td>`;
  const dataBR = (iso) => iso ? iso.slice(0, 10).split("-").reverse().join("/") : "–";
  const dinheiro = (v) => {
    if (v == null) return "–";
    const a = Math.abs(v);
    if (a >= 1e9) return "R$ " + (v / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " bi";
    if (a >= 1e6) return "R$ " + (v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
    if (a >= 1e3) return "R$ " + (v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " mil";
    return "R$ " + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------ carga
  async function carregar() {
    try {
      const r = await fetch("data/resumo.json?v=" + Date.now());
      if (!r.ok) throw new Error(r.status);
      estado.resumo = await r.json();
    } catch (e) {
      $("#corpo").innerHTML = `<tr><td colspan="10" class="vazio">Os dados ainda não foram gerados. Rode o robô de atualização uma vez (aba Actions do GitHub).</td></tr>`;
      $("#carimbo").textContent = "";
      return;
    }
    const R = estado.resumo;
    document.title = R.titulo;
    $("#titulo").textContent = R.titulo;
    $("#subtitulo").textContent = R.subtitulo || "";
    $("#carimbo").innerHTML = `Cotas até <strong>${dataBR(R.data_base)}</strong><br>Atualizado em ${dataBR(R.atualizado_em)} ${R.atualizado_em.slice(11, 16)}`;
    montarCategorias();
    desenharTabela();
    desenharGestao();
    abrirPeloHash();
  }

  // ------------------------------------------------------------ abas
  $$(".aba").forEach((b) => b.addEventListener("click", () => {
    $$(".aba").forEach((x) => x.classList.toggle("ativa", x === b));
    $$(".painel").forEach((p) => p.classList.toggle("ativo", p.id === "aba-" + b.dataset.aba));
  }));

  // ------------------------------------------------------------ tabela principal
  function visiveis() {
    return estado.resumo.fundos.filter((f) => f.ativo && f.ultima_data);
  }

  function montarCategorias() {
    const cats = ["Todas", ...new Set(visiveis().map((f) => f.categoria))];
    $("#categorias").innerHTML = cats.map((c) => `<button class="chip${c === estado.categoria ? " ativo" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("");
    $$("#categorias .chip").forEach((b) => b.addEventListener("click", () => {
      estado.categoria = b.dataset.c;
      montarCategorias();
      desenharTabela();
    }));
  }

  const valorCol = (f, col) => {
    switch (col) {
      case "nome": return f.nome.toLowerCase();
      case "pct12": return f.pct_cdi?.m12;
      case "vol12": return f.vol12;
      case "pl": return f.pl;
      default: return f.ret?.[col];
    }
  };

  function linhaCDI(lista) {
    // CDI de referência: usa o fundo com dados mais recentes para pegar o CDI das mesmas janelas
    const ref = [...lista].sort((a, b) => (b.ultima_data > a.ultima_data ? 1 : -1))
      .find((f) => f.cdi && f.cdi.m12 != null) || lista.find((f) => f.cdi);
    if (!ref) return "";
    const c = ref.cdi;
    return `<tr class="ref"><td class="txt fixa"><span class="nome-fundo">CDI</span><span class="meta-fundo">referência · até ${dataBR(ref.ultima_data)}</span></td>
      ${celPct(c.dia, 3)}${celPct(c.mes)}${celPct(c.ano)}${celPct(c.m12)}${celPct(c.m24)}${celPct(c.m36)}
      <td class="nd">100%</td><td class="nd">–</td><td class="nd">–</td></tr>`;
  }

  function desenharTabela() {
    const q = estado.busca.trim().toLowerCase();
    const qd = q.replace(/\D/g, "");
    let lista = visiveis().filter((f) =>
      (estado.categoria === "Todas" || f.categoria === estado.categoria) &&
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
      $("#corpo").innerHTML = `<tr><td colspan="10" class="vazio">Nenhum fundo encontrado.</td></tr>`;
      return;
    }
    $("#corpo").innerHTML = linhaCDI(lista) + lista.map((f) => `
      <tr data-chave="${esc(f.chave)}">
        <td class="txt fixa"><span class="nome-fundo">${esc(f.nome)}</span><span class="meta-fundo">${esc(f.categoria)} · ${dataBR(f.ultima_data)}${f.status === "defasado" ? " · ⚠ defasado" : ""}</span></td>
        ${celPct(f.ret.dia, 3)}${celPct(f.ret.mes)}${celPct(f.ret.ano)}${celPct(f.ret.m12)}${celPct(f.ret.m24)}${celPct(f.ret.m36)}
        <td>${f.pct_cdi.m12 == null ? '<span class="nd">–</span>' : pct(f.pct_cdi.m12, 0)}</td>
        <td>${pct(f.vol12)}</td>
        <td>${dinheiro(f.pl)}</td>
      </tr>`).join("");
    $$("#corpo tr[data-chave]").forEach((tr) => tr.addEventListener("click", () => abrir(tr.dataset.chave)));
  }

  $$("#tabela th").forEach((th) => th.addEventListener("click", () => {
    const col = th.dataset.col;
    estado.ordem = estado.ordem.col === col ? { col, asc: !estado.ordem.asc } : { col, asc: col === "nome" };
    desenharTabela();
  }));
  $("#busca").addEventListener("input", (e) => { estado.busca = e.target.value; desenharTabela(); });

  // ------------------------------------------------------------ aba Fundos (gestão)
  function desenharGestao() {
    const R = estado.resumo;
    const repo = R.repo;
    const br = R.branch || "main";
    const link = (href, txt, prim) => `<a class="botao${prim ? " primario" : ""}" href="${href}" target="_blank" rel="noopener"${repo ? "" : ' aria-disabled="true"'}>${txt}</a>`;
    $("#acoes-gestao").innerHTML =
      link(`https://github.com/${repo}/edit/${br}/fundos.yaml`, "Editar lista de fundos", true) +
      link(`https://github.com/${repo}/actions`, "Ver atualizações");

    $("#avisos").innerHTML = R.avisos && R.avisos.length
      ? `<div class="alerta"><strong>Pontos de atenção na última atualização</strong><ul>${R.avisos.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : "";

    const rotulo = { ok: "Atualizado", defasado: "Defasado", nao_encontrado: "Não encontrado" };
    $("#corpo-fundos").innerHTML = R.fundos.map((f) => {
      const st = f.ativo ? f.status : "inativo";
      return `<tr>
        <td class="txt">${esc(f.nome)}</td>
        <td class="txt" style="font-family:var(--mono);font-size:12px">${esc(f.cnpj)}${f.subclasse ? " · " + esc(f.subclasse) : ""}</td>
        <td class="txt">${esc(f.categoria)}</td>
        <td class="txt"><span class="selo ${st}">${f.ativo ? rotulo[f.status] || f.status : "Oculto"}</span></td>
        <td>${dataBR(f.ultima_data)}</td>
        <td>${dataBR(f.inicio_historico)}</td></tr>`;
    }).join("");
  }

  // ------------------------------------------------------------ detalhe
  async function abrir(chave) {
    const f = estado.resumo.fundos.find((x) => x.chave === chave);
    if (!f) return;
    history.replaceState(null, "", "#f=" + encodeURIComponent(chave));
    $("#det-cat").textContent = f.categoria;
    $("#det-nome").textContent = f.nome;
    $("#det-cnpj").textContent = `CNPJ ${f.cnpj}${f.subclasse ? " · subclasse " + f.subclasse : ""} · cota de ${dataBR(f.ultima_data)}`;
    const kpi = (r, v, s) => `<div class="kpi"><div class="r">${r}</div><div class="v ${typeof v === "number" ? cls(v) : ""}">${typeof v === "number" ? pct(v) : v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
    $("#kpis").innerHTML =
      kpi("No ano", f.ret.ano, f.pct_cdi.ano != null ? pct(f.pct_cdi.ano, 0) + " do CDI" : "") +
      kpi("12 meses", f.ret.m12 ?? "–", f.pct_cdi.m12 != null ? pct(f.pct_cdi.m12, 0) + " do CDI" : "") +
      kpi("24 meses", f.ret.m24 ?? "–", f.pct_cdi.m24 != null ? pct(f.pct_cdi.m24, 0) + " do CDI" : "") +
      kpi("Volatilidade 12m", f.vol12 != null ? pct(f.vol12) : "–", "anualizada") +
      kpi("Maior queda 12m", f.mdd12 != null ? pct(f.mdd12) : "–", "drawdown") +
      kpi("Patrimônio", dinheiro(f.pl), f.cotistas != null ? f.cotistas.toLocaleString("pt-BR") + " cotistas" : "");

    $("#veu").hidden = false;
    $("#detalhe").hidden = false;
    document.body.style.overflow = "hidden";
    $("#grafico").innerHTML = '<div class="vazio">Carregando…</div>';
    $("#mensal").innerHTML = "";

    try {
      if (!estado.cache[chave]) {
        const r = await fetch(`data/fundos/${encodeURIComponent(chave)}.json?v=${estado.resumo.atualizado_em}`);
        estado.cache[chave] = await r.json();
      }
    } catch (e) {
      $("#grafico").innerHTML = '<div class="vazio">Não foi possível carregar o histórico.</div>';
      return;
    }
    const det = estado.cache[chave];
    montarPeriodos(det);
    desenharMensal(det);
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

  function abrirPeloHash() {
    const m = location.hash.match(/^#f=(.+)$/);
    if (m) abrir(decodeURIComponent(m[1]));
  }

  // ------------------------------------------------------------ gráfico (SVG próprio, sem dependências)
  const PERIODOS = [["6M", 6], ["1A", 12], ["2A", 24], ["3A", 36], ["5A", 60], ["Máx", 0]];

  function montarPeriodos(det) {
    const d = det.serie.d;
    const ini = new Date(d[0]), fim = new Date(d[d.length - 1]);
    const mesesHist = (fim - ini) / (30.44 * 864e5);
    const padrao = mesesHist >= 11.5 ? "1A" : "Máx";
    $("#periodos").innerHTML = PERIODOS.map(([r, m]) =>
      `<button data-m="${m}" ${m && m > mesesHist + 0.5 ? "disabled" : ""} class="${r === padrao ? "ativo" : ""}">${r}</button>`).join("");
    $$("#periodos button").forEach((b) => b.addEventListener("click", () => {
      $$("#periodos button").forEach((x) => x.classList.toggle("ativo", x === b));
      desenharGrafico(det, +b.dataset.m);
    }));
    desenharGrafico(det, +$("#periodos button.ativo").dataset.m);
  }

  function desenharGrafico(det, meses) {
    const { d, c, i } = det.serie;
    let k0 = 0;
    if (meses) {
      const fim = new Date(d[d.length - 1]);
      const corte = new Date(fim); corte.setMonth(corte.getMonth() - meses);
      const alvo = corte.toISOString().slice(0, 10);
      k0 = d.findIndex((x) => x >= alvo);
      if (k0 > 0 && d[k0] > alvo) k0 -= 1; // base = última cota antes do corte
      if (k0 < 0) k0 = 0;
    }
    const D = d.slice(k0), C = c.slice(k0), I = i ? i.slice(k0) : null;
    const f = C.map((v) => v / C[0] - 1);
    const b = I && I[0] ? I.map((v) => (v == null ? null : v / I[0] - 1)) : null;

    const W = Math.max(300, Math.min(840, $("#grafico").clientWidth - 16 || 820));
    const H = W < 520 ? 230 : 300, m = { t: 14, r: 12, b: 26, l: 46 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const todos = f.concat(b ? b.filter((v) => v != null) : []);
    let lo = Math.min(0, ...todos), hi = Math.max(0, ...todos);
    const pad = (hi - lo) * 0.08 || 0.01; lo -= pad; hi += pad;
    const x = (k) => m.l + (D.length < 2 ? 0 : (k / (D.length - 1)) * iw);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
    const caminho = (arr) => arr.map((v, k) => v == null ? "" : `${k && arr[k - 1] != null ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");

    // grade Y
    const passo = escolherPasso((hi - lo) / 5);
    let grade = "";
    for (let v = Math.ceil(lo / passo) * passo; v <= hi; v += passo) {
      grade += `<line class="grade" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="eixo" x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${(Math.abs(v) < 1e-9 ? 0 : v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</text>`;
    }
    // rótulos X
    let rot = "";
    const n = W < 520 ? 3 : 5;
    for (let j = 0; j <= n; j++) {
      const k = Math.round((j / n) * (D.length - 1));
      const [aa, mm] = D[k].split("-");
      rot += `<text class="eixo" x="${x(k)}" y="${H - 6}" text-anchor="${j === 0 ? "start" : j === n ? "end" : "middle"}">${MESES[+mm - 1]}/${aa.slice(2)}</text>`;
    }
    const cor = getComputedStyle(document.documentElement);
    $("#grafico").innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rentabilidade acumulada do fundo e do CDI">
        ${grade}
        <line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>
        ${b ? `<path d="${caminho(b)}" fill="none" stroke="${cor.getPropertyValue("--cdi")}" stroke-width="1.6"/>` : ""}
        <path d="${caminho(f)}" fill="none" stroke="${cor.getPropertyValue("--marca-2")}" stroke-width="2"/>
        ${rot}
        <line id="mira" y1="${m.t}" y2="${m.t + ih}" stroke="${cor.getPropertyValue("--suave")}" stroke-width="1" visibility="hidden"/>
        <circle id="pf" r="3.5" fill="${cor.getPropertyValue("--marca-2")}" visibility="hidden"/>
        <circle id="pc" r="3" fill="${cor.getPropertyValue("--cdi")}" visibility="hidden"/>
        <rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" id="area"/>
      </svg><div class="dica" id="dica" hidden></div>`;

    const svg = $("#grafico svg"), dica = $("#dica");
    const mover = (ev) => {
      const p = ev.touches ? ev.touches[0] : ev;
      const r = svg.getBoundingClientRect();
      const sx = ((p.clientX - r.left) / r.width) * W;
      const k = Math.max(0, Math.min(D.length - 1, Math.round(((sx - m.l) / iw) * (D.length - 1))));
      const X = x(k);
      $("#mira", svg).setAttribute("x1", X); $("#mira", svg).setAttribute("x2", X);
      $("#mira", svg).setAttribute("visibility", "visible");
      $("#pf", svg).setAttribute("cx", X); $("#pf", svg).setAttribute("cy", y(f[k])); $("#pf", svg).setAttribute("visibility", "visible");
      if (b && b[k] != null) { $("#pc", svg).setAttribute("cx", X); $("#pc", svg).setAttribute("cy", y(b[k])); $("#pc", svg).setAttribute("visibility", "visible"); }
      dica.hidden = false;
      dica.style.left = (X / W) * r.width + 8 + "px";
      dica.style.top = (Math.min(y(f[k]), b && b[k] != null ? y(b[k]) : 1e9) / H) * r.height + 8 + "px";
      dica.innerHTML = `${dataBR(D[k])}<br>Fundo ${pct(f[k])}${b && b[k] != null ? `<br>CDI ${pct(b[k])}` : ""}`;
    };
    const sair = () => { dica.hidden = true; ["#mira", "#pf", "#pc"].forEach((s) => $(s, svg).setAttribute("visibility", "hidden")); };
    const area = $("#area", svg);
    area.addEventListener("mousemove", mover);
    area.addEventListener("touchmove", (e) => { mover(e); }, { passive: true });
    area.addEventListener("touchstart", mover, { passive: true });
    area.addEventListener("mouseleave", sair);
    area.addEventListener("touchend", sair);
  }

  function escolherPasso(bruto) {
    const p = Math.pow(10, Math.floor(Math.log10(bruto)));
    const n = bruto / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  // ------------------------------------------------------------ tabela mensal
  function desenharMensal(det) {
    const cab = `<thead><tr><th>Ano</th>${MESES.map((m) => `<th>${m}</th>`).join("")}<th>Ano</th></tr></thead>`;
    const linhas = det.mensal.map((a) => {
      const cel = (v, c) => v == null ? `<td class="nd">–</td>` :
        `<td><span class="${cls(v)}">${pct(v)}</span>${c != null && c > 0 ? `<span class="p">${pct(v / c, 0)}</span>` : ""}</td>`;
      const meses = a.fundo.map((v, k) => cel(v, a.cdi[k])).join("");
      const tot = a.fundo_ano == null ? `<td class="tot nd">–</td>` :
        `<td class="tot"><span class="${cls(a.fundo_ano)}">${pct(a.fundo_ano)}</span>${a.cdi_ano > 0 ? `<span class="p">${pct(a.fundo_ano / a.cdi_ano, 0)}</span>` : ""}</td>`;
      return `<tr><td>${a.ano}${a.parcial ? "*" : ""}</td>${meses}${tot}</tr>`;
    }).join("");
    $("#mensal").innerHTML = cab + `<tbody>${linhas}</tbody>`;
  }

  carregar();
})();
