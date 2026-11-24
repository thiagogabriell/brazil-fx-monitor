# Brazil FX Monitor

Monitoramento contínuo das reservas internacionais do Brasil, das intervenções
cambiais do Banco Central, do fluxo de dólares e da pressão sobre o real.

Site publicado: <https://thiagogabriell.github.io/brazil-fx-monitor/>

A aplicação é estática, roda inteira no GitHub Pages, é alimentada por rotinas
do GitHub Actions e usa apenas fontes oficiais abertas. O custo recorrente é
zero.

---

## A página inicial

Uma pergunta só: **quanto o Brasil tem de reservas e quanto saiu em cada dia.**

| Coluna | O que é |
|---|---|
| Quanto sobrou | saldo das reservas naquele dia |
| Mudou no dia | variação do saldo. Inclui rendimento e variação entre moedas, não é só venda |
| Vendido pelo BC | venda definitiva de dólares, liquidada naquele dia. Sai das reservas de vez |
| Operação temporária | o BC empresta dólares e recebe de volta na data combinada. Não é gasto permanente |

Três relógios diferentes, porque o Banco Central publica em ritmos diferentes, e
a página diz qual é qual em vez de misturar:

| Informação | Atraso |
|---|---|
| Cotação do dólar | tempo real, fonte de mercado |
| Saldo das reservas e variação do dia | um dia útil |
| Venda confirmada pelo BC | **uma publicação por mês**, de três a oito semanas |

Por isso a coluna "Vendido pelo BC" aparece como *ainda não publicado* nos dias
recentes. Não é falta de dado nesta aplicação: é o ritmo de divulgação do Banco
Central, e preencher esse espaço com estimativa seria inventar.

## As outras páginas

Treze páginas de detalhe continuam no repositório, acessíveis pelo menu lateral
a partir de "Ver tudo em detalhe": extrato conciliado dia a dia, calendário de
intervenções, composição das reservas, histórico por tipo de operação, fluxo
cambial, efetividade das intervenções, índice de pressão, alertas e simulador.

## Princípios que o código respeita

Estes não são detalhes de apresentação, são regras verificadas por testes
automatizados (`tests/test_acceptance_rules.py`):

1. **Swap cambial não é venda de dólares.** O valor nocional de um swap nunca
   entra em nenhum total de venda. Ele aparece em campo próprio, sempre
   rotulado como nocional.
2. **Operação anunciada não é operação realizada.** Um leilão sem volume aceito
   publicado nunca conta como venda.
3. **Nenhuma operação é contada duas vezes.** Cada operação tem identificador
   estável. Quando o Banco Central publica duas linhas idênticas em todos os
   campos, as duas são mantidas e marcadas como possível duplicidade, porque
   remover uma alteraria o total oficial.
4. **Queda nas reservas não é prova de venda de dólares.** O que as operações
   confirmadas não explicam é publicado como *variação não identificada*,
   sem causa inventada.
5. **Operação temporária não é consumo permanente.** Venda com recompra,
   compromissada e empréstimo entram como saída na liquidação e como entrada no
   vencimento, com o saldo em aberto acompanhado separadamente.
6. **Dado ausente nunca vira zero.** Ele é `null` nos arquivos e aparece como
   "não disponível" na interface.
7. **Séries com frequências diferentes não são apresentadas como simultâneas.**
   Cada bloco mostra a própria data de referência; as atuações do BCB têm
   divulgação mensal e a interface diz isso o tempo todo.
8. **Classe de ativo não é inferida.** Só aparece quando a modalidade publicada
   a identifica. Caso contrário: "Ativo de origem não divulgado pelo Banco
   Central."
9. **Conceito caixa e conceito liquidez são tratados separadamente** e nunca
   somados.
10. **Revisão da fonte é rastreada.** Quando o Banco Central corrige um valor já
    publicado, a alteração fica registrada e os cálculos são refeitos.

## Arquitetura

```
Banco Central (SGS, Dados Abertos, Olinda)
        │
        ▼
GitHub Actions  ──►  scripts/collect_*.py  ──►  data/**/*.json
        │                                            │
        ▼                                            ▼
scripts/reconcile_reserves.py                 GitHub Pages
scripts/calculate_indicators.py                      │
scripts/generate_alerts.py                           ▼
scripts/generate_daily_summary.py            navegador do usuário
scripts/validate_data.py                     (ECharts + fetch de JSON)
```

Sem servidor, sem banco de dados, sem serviço pago, sem chave de API. A coleta e
o processamento usam apenas a biblioteca padrão do Python 3.12.

### Estrutura

```
brazil-fx-monitor/
    index.html                  Visão geral
    pages/                      13 páginas, uma por área
    assets/css/, assets/js/     Interface e gráficos
    data/
        reserves/               Saldos diários e extrato conciliado por ano
        interventions/          Operações, fragmentos por ano e comunicados
        exchange-rates/         PTAX histórica e boletins recentes
        exchange-flow/          Balanço de pagamentos mensal
        composition/            Disponibilidade e fontes oficiais
        indicators/             Agregados, efetividade, pressão, padrões, resumo
        alerts/                 Alertas ativos, histórico e regras
        metadata/               Estado da última coleta de cada fonte
    scripts/                    Coleta, conciliação, indicadores, validação
    tests/                      Testes de aceitação, cálculo e frontend
    .build/                     Geradores do HTML e dos feriados
    .github/                    Workflows e ação composta de processamento
```

As páginas HTML são geradas a partir de `.build/bodies/*.html` por
`.build/make_pages.py`, que também carimba a versão dos assets nas URLs de CSS e
JavaScript. Depois de alterar qualquer arquivo em `assets/`, rode:

```bash
python3 .build/make_pages.py
```

O workflow de testes falha se as páginas estiverem dessincronizadas.

## Fontes de dados

| Fonte | Endpoint | Unidade | Frequência | Histórico |
|---|---|---|---|---|
| Reservas, conceito caixa (SGS 13621) | `api.bcb.gov.br/dados/serie/bcdata.sgs.13621/dados` | US$ milhões | Diária, dias úteis | desde 04/01/1999 |
| Reservas, conceito liquidez (SGS 13982) | `api.bcb.gov.br/dados/serie/bcdata.sgs.13982/dados` | US$ milhões | Diária, dias úteis | desde 02/01/2008 |
| Atuações no mercado de câmbio | `bcb.gov.br/conteudo/dadosabertos/BCBDepin/historico-atuacoes-mercado-cambio.csv` | US$ | **Mensal** | desde 18/01/1999 |
| PTAX venda (SGS 1) e compra (SGS 10813) | `api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados` | R$/US$ | Diária, dias úteis | desde 04/01/1999 |
| Boletins PTAX (Olinda OData) | `olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata` | R$/US$ | Diária | janela consultada |
| Balanço de pagamentos (SGS 22701, 22707-22709, 22864, 22885, 22905, 22924, 22969) | `api.bcb.gov.br/dados/serie/bcdata.sgs.22701/dados` | US$ milhões | Mensal | desde 01/1995 |
| Cotação ao vivo USD/BRL | `economia.awesomeapi.com.br/json/last/USD-BRL` | R$/US$ | Intradiária | momento atual |

Todas as fontes do Banco Central são abertas, sem autenticação, sob licença
Open Data Commons Open Database License (ODbL). A cotação ao vivo é fonte
secundária, consultada **pelo navegador** e nunca gravada no repositório; ela
aparece sempre com o rótulo "fonte secundária".

A página **Fontes e metodologia** traz o catálogo completo com metodologia,
limitações, restrições de acesso e data da última coleta de cada fonte.

## Limitações conhecidas

- As atuações no mercado de câmbio têm **divulgação mensal**. Entre a última
  atuação publicada e hoje, a aplicação mostra "sem dados disponíveis", nunca
  "sem intervenção".
- A fonte de atuações descreve as operações no momento da publicação do
  resultado e **não reflete cancelamentos nem pré-pagamentos** posteriores.
  Por isso o status "cancelada" não existe nesta aplicação.
- O **motivo oficial** de cada intervenção não está no conjunto de dados. A
  aplicação sempre leva ao comunicado correspondente no site do Banco Central.
- Não há **horário de execução** por operação, apenas o horário de divulgação do
  comunicado e do anúncio.
- A **composição das reservas** por moeda e por classe de ativo não é publicada
  em API. Só existe no relatório anual em PDF. A aplicação não exibe
  percentuais estimados; exibe a ausência e os links oficiais.
- O **fluxo cambial contratado semanal** não tem API pública nem série no SGS.
  A verificação do catálogo completo (4.261 conjuntos de dados) não encontra
  nenhum. A página de fluxo usa o balanço de pagamentos mensal e diz isso.
- A **dívida externa de curto prazo em dólares** não está disponível no portal
  aberto. O componente correspondente do indicador de pressão fica sem dado e
  com peso zero.
- A **efetividade das intervenções** usa fechamentos diários da PTAX, porque não
  existe série intradiária gratuita e confiável para o horário dos leilões.
  Correlação não é causalidade.
- Agendamentos do GitHub Actions podem atrasar em períodos de fila alta e são
  **desativados automaticamente após 60 dias sem atividade** em repositórios
  públicos. Basta um commit ou uma execução manual para reativar.

## Indicador de pressão cambial

Metodologia **experimental desta aplicação**. Não é classificação oficial do
Banco Central, não é previsão de crise e não é recomendação financeira.

Doze componentes, cada um com peso declarado e uma função linear por partes com
pontos de quebra visíveis na interface e no código (`scripts/pressure_index.py`).
A pontuação é a média ponderada apenas dos componentes com dado, renormalizada
pelo peso disponível. Abaixo de 60% de cobertura a pontuação não é exibida, para
não dar precisão que os dados não sustentam.

Faixas: 0-20 Normal · 21-40 Atenção · 41-60 Pressão elevada · 61-80 Pressão
severa · 81-100 Pressão crítica.

## Automação

| Workflow | Quando roda | O que faz |
|---|---|---|
| `collect-intraday.yml` | Dias úteis, 4 vezes ao dia, horários de publicação | PTAX e reservas |
| `collect-daily.yml` | Dias úteis, 17h40 de São Paulo | Todas as fontes |
| `collect-interventions.yml` | Dias úteis a partir do dia 20 e às segundas | Atuações e comunicados |
| `validate-sources.yml` | Dias úteis, manhã | Confere endpoints e layout do CSV |
| `tests.yml` | Push e pull request | Testes e validação dos dados |
| `deploy.yml` | Após commit de dados e em push no site | Publica no Pages e confere a URL |

Todos têm `workflow_dispatch`, controle de concorrência, permissões mínimas e
ações fixadas por SHA. As rotinas de coleta pulam feriados bancários
(`.github/holidays-br.txt`) e **só fazem commit quando há alteração real de
dados**: se apenas o carimbo de hora da coleta mudou, o commit é descartado.

## Rodando localmente

```bash
git clone https://github.com/thiagogabriell/brazil-fx-monitor.git
cd brazil-fx-monitor

# Coleta (usa só a biblioteca padrão)
python3 scripts/collect_reserves.py
python3 scripts/collect_exchange_rates.py
python3 scripts/collect_interventions.py
python3 scripts/collect_announcements.py
python3 scripts/collect_exchange_flow.py
python3 scripts/collect_composition.py

# Processamento
python3 scripts/reconcile_reserves.py
python3 scripts/calculate_indicators.py
python3 scripts/generate_alerts.py
python3 scripts/generate_daily_summary.py
python3 scripts/validate_data.py

# Testes
python3 -m pip install -r requirements-dev.txt
python3 -m pytest tests -q
BFX_LIVE_TESTS=1 python3 -m pytest tests/test_sources_live.py -q

# Servir o site (de um diretório acima, para testar o subcaminho do Pages)
cd .. && python3 -m http.server 8899
# abra http://127.0.0.1:8899/brazil-fx-monitor/
```

## Custo

US$ 0 por mês. GitHub Pages e GitHub Actions em repositório público não geram
cobrança, não há serviço externo pago, nenhuma API exige assinatura e nenhum
segredo é necessário.

## Licença

Código sob [MIT](LICENSE). Os dados em `data/` vêm do Banco Central do Brasil e
estão sob Open Data Commons Open Database License (ODbL). Detalhes em
[NOTICE](NOTICE).

## Aviso

Esta aplicação é uma ferramenta de monitoramento de dados públicos. Não é
produto do Banco Central do Brasil, não constitui recomendação de investimento e
não deve ser usada como base para decisões financeiras.
