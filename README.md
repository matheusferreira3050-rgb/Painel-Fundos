# Painel de Fundos

Site público com a rentabilidade de uma lista de fundos, atualizado todos os dias com os
Informes Diários da CVM e o CDI do Banco Central. Roda 100% no GitHub, sem servidor e sem custo.

```
fundos.yaml                  ← a lista de fundos (é o único arquivo que você precisa editar)
scripts/atualizar.py         ← robô: baixa CVM + CDI, calcula rentabilidades, gera os dados do site
.github/workflows/...yml     ← agenda o robô 2x por dia e publica o site
docs/                        ← o site (index.html, app.js, style.css)
data/                        ← base histórica de cotas e CDI (o robô mantém sozinho)
```

## Colocar no ar (uma vez só, ~15 minutos)

1. **Crie o repositório.** No GitHub, clique em *New repository*, dê um nome (ex.: `painel-fundos`),
   marque **Public** e crie.
2. **Envie os arquivos.** Em *Add file → Upload files*, arraste o conteúdo desta pasta.
   ⚠️ A pasta `.github` é oculta no Mac/Windows e às vezes não vai no arrastar. Se depois do upload
   ela não aparecer no repositório, crie o arquivo à mão: *Add file → Create new file*, nome
   `.github/workflows/atualizar.yml`, e cole o conteúdo do arquivo.
3. **Ative o site.** *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
4. **Dê permissão ao robô.** *Settings → Actions → General → Workflow permissions:*
   **Read and write permissions** → *Save*.
5. **Coloque seus fundos** em `fundos.yaml` (veja abaixo) e salve.
6. **Primeira execução.** Aba *Actions* → *Atualizar cotas e publicar site* → *Run workflow*.
   A primeira vez demora mais (baixa 5 anos de histórico, ~15–25 min). As seguintes levam 1–2 min.
7. O site fica em `https://SEU-USUARIO.github.io/painel-fundos/`.

## Trocar os fundos (revisão semestral)

No site, aba **Fundos → Editar lista de fundos** (abre o `fundos.yaml` no GitHub, pedindo seu login).
Edite e clique em *Commit changes*. O robô roda sozinho, baixa o histórico dos novos e republica.

```yaml
  - cnpj: "12.345.678/0001-90"   # CNPJ da CLASSE do fundo
    nome: "Nome que aparece no site"
    categoria: "Renda Fixa"       # vira filtro no site
    subclasse: ""                 # só se o fundo tiver subclasses na CVM
    ativo: true                   # false esconde do site sem apagar o histórico
```

A aba **Fundos** também mostra avisos da última atualização: CNPJ não encontrado na CVM,
fundo com cota parada há muitos dias ou fundo com subclasses (aí você escolhe qual usar).

### Campos opcionais de cada fundo

- `isento_ir: true`: marca o fundo como isento de IR para PF e habilita o gross-up no site.
- `subclasse: "CODIGO"`: escolhe a subclasse quando a CVM lista mais de uma. Os códigos aparecem nos avisos da aba Fundos.
- `taxa_adm`, `taxa_perf`, `resgate`, `aplicacao_minima`, `gestor`, `observacao`: aparecem no detalhe do fundo e substituem o que vier do cadastro da CVM.

## Atualização diária

O robô roda às 08h17 e 19h47 (Brasília). Os administradores enviam o informe à CVM com
defasagem, então a "data da cota" no site costuma ser de 1 a 2 dias úteis atrás. A cada rodada
ele rebaixa o mês atual e o anterior, o que já corrige eventuais reenvios/retificações.

Se o GitHub enviar e-mail dizendo que o agendamento foi desativado por inatividade, basta
entrar em *Actions* e reativar.

## Cálculos

- Dia, mês, ano, 6/12/24/36/60 meses e desde o início do histórico, sempre pela cota (já líquida de taxas, bruta de IR).
- % CDI = retorno do fundo ÷ CDI acumulado entre as mesmas datas (CDI: SGS série 12 do Banco Central).
- Volatilidade 12m anualizada (√252) e drawdown máximo.
- Tabela mês a mês com % do CDI de cada mês, consistência (meses ≥ CDI nos últimos 24) e pior mês.
- Gross-up dos isentos: retorno ÷ (1 − alíquota), com alíquota configurável em `aliquota_grossup`.
- Qualidade dos dados: lacunas de mais de 10 dias deixam os períodos afetados em "–"; variações atípicas são sinalizadas (mercado × isoladas). Os dados da CVM nunca são alterados.
- Comparador: marque até 5 fundos na tabela e clique em Comparar.

## Rodar no seu computador (opcional)

```bash
pip install -r requirements.txt
python scripts/atualizar.py
cd docs && python -m http.server   # abra http://localhost:8000
```

## Avisos regulatórios

O site já traz os avisos padrão (rentabilidade passada, ausência de garantia do FGC, análise
mínima de 12 meses, caráter informativo). Como o painel é público e você atua como assessor,
valide o texto e a divulgação com o compliance antes de compartilhar com clientes.
