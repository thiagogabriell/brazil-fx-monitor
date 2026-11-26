# Pesquisa e validação das fontes oficiais

Levantamento feito em 24/11/2026 contra os endpoints reais, não contra
documentação. Cada afirmação abaixo foi verificada com uma requisição.

## Método

1. Listagem completa do catálogo do Portal de Dados Abertos do Banco Central
   (`/api/3/action/package_list`): **4.261 conjuntos de dados**.
2. Busca por termos: `reservas`, `cambio`, `cambial`, `fluxo`, `contratado`,
   `composicao`, `divida-externa`, `curto-prazo`, `ouro`,
   `direitos-especiais`, `posicao-de-reserva`.
3. Chamada real a cada endpoint candidato, com verificação de formato, unidade,
   cobertura histórica e comportamento em erro.

## O que existe

### Reservas internacionais

Apenas dois conjuntos de dados, ambos só com o total:

| Série | Nome oficial | Unidade | Frequência | Primeira observação |
|---|---|---|---|---|
| SGS 13621 | Reservas internacionais - Conceito caixa - Total - diária | US$ milhões | diária, dias úteis | 04/01/1999 |
| SGS 13982 | Reservas internacionais - Conceito liquidez - Total - diária | US$ milhões | diária, dias úteis | 02/01/2008 |

Endpoint: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.<codigo>/dados?formato=json&dataInicial=dd/mm/aaaa&dataFinal=dd/mm/aaaa`

**Restrição confirmada pelo próprio serviço:** em séries diárias a janela de
consulta é de no máximo dez anos. Uma requisição maior devolve:

> "O sistema aceita uma janela de consulta de, no máximo, 10 anos em séries de
> periodicidade diária"

Os coletores quebram o histórico em janelas de nove anos.

**Comportamento em instabilidade:** o gateway responde esporadicamente HTTP 502
e, pior, HTTP 200 com uma página HTML de erro. O cliente trata corpo não-JSON
como falha transitória e repete a requisição com espera exponencial, em vez de
tratar como dado ausente.

### Atuações no mercado de câmbio

Conjunto `historico-de-atuacoes-no-mercado-de-cambio`, publicado pelo
Departamento das Reservas Internacionais.

- CSV: `https://www.bcb.gov.br/conteudo/dadosabertos/BCBDepin/historico-atuacoes-mercado-cambio.csv`
- Documentação: `https://www.bcb.gov.br/conteudo/dadosabertos/BCBDepin/documentacao-atuacoes-mercado-cambio.pdf`
- Licença: Open Data Commons Open Database License (ODbL)
- Período declarado: desde 18/01/1999
- Frequência declarada: **mensal**

Texto do próprio Banco Central, que define duas limitações estruturais:

> "Os dados descrevem as atuações até o momento de publicação do resultado de
> cada uma e, portanto, não abrangem fatos ocorridos depois da data da atuação,
> tais como cancelamentos e pré-pagamentos de operações negociadas nas
> atuações."

> "A série é atualizada até o último dia útil do mês e apresenta dados relativos
> às atuações ocorridas no mês anterior, quando houver."

Colunas do CSV, nesta ordem:

```
Comunicação, Data Hora Comunicação, Comunicado, Data Hora Comunicado,
Data Hora Anúncio, Procedimento Operacional, Data, Instrumento, Modalidade,
Tipo Composto, Data de Liquidação, Data de Vencimento,
Volume USD Ofertado, Volume USD Aceito, Taxa de Corte
```

Valores distintos encontrados (10.507 linhas):

| Instrumento | Modalidades | Linhas | Efeito nas reservas |
|---|---|---|---|
| Swap Cambial | Tradicional, Reverso | 7.948 | nenhum (nocional) |
| Compra a Vista | Mercado | 1.506 | aumenta |
| Venda a Vista | Mercado, PTAX, ACC/ACE | 530 | reduz |
| Venda com Recompra | Pré-fixado, Pós-fixado Selic | 467 | reduz temporariamente |
| Compra a Termo | Mercado | 28 | aumenta na liquidação |
| Operação Compromissada | Títulos Soberanos (Global Bonds) | 15 | reduz temporariamente |
| Empréstimo | ACC/ACE, Sem Direcionamento, Títulos Soberanos | 13 | reduz temporariamente |

Procedimentos operacionais: Leilão Eletrônico (10.048), Operação Direta (292),
Leilão Telefônico (167).

Tipos compostos: vazio (10.304), "Leilão à Vista + Swap Reverso" (183),
"Leilão Conjugado + Empréstimo" (20).

**A modalidade é a única pista oficial sobre classe de ativo.** Apenas
"Títulos Soberanos (Global Bonds)" identifica o ativo. Em todos os outros casos
a aplicação informa que o ativo de origem não foi divulgado.

**Duplicidade ambígua:** uma linha é publicada duas vezes com todos os campos
idênticos (13/09/2001, Venda a Vista, US$ 50 milhões). Não é possível saber se
são duas operações iguais ou uma repetição do registro. As duas linhas são
mantidas, com identificadores distintos e marcadas com `ambiguous_duplicate`.

**Volume aceito ausente:** 13 linhas não têm volume aceito publicado. Elas
recebem status `pendente_de_confirmacao` e não entram em nenhum total.

### Taxa de câmbio

| Série | Nome oficial | Unidade | Primeira observação |
|---|---|---|---|
| SGS 1 | Taxa de câmbio - Livre - Dólar americano (venda) - diário | R$/US$ | 04/01/1999 |
| SGS 10813 | Taxa de câmbio - Livre - Dólar americano (compra) | R$/US$ | 04/01/1999 |

Serviço Olinda PTAX (OData v1) para os boletins com horário de publicação:

```
https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/
  CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)
  ?@dataInicial='mm-dd-aaaa'&@dataFinalCotacao='mm-dd-aaaa'&$format=json
```

O parâmetro de data usa o formato **mm-dd-aaaa entre apóstrofos**. A resposta
traz `dataHoraCotacao` no fuso de São Paulo, sem offset.

O Banco Central **não publica cotação de mercado em tempo real**. A PTAX é uma
taxa de referência calculada a partir de quatro consultas diárias.

### Balanço de pagamentos

Séries mensais em US$ milhões, desde 01/1995:

| Série | Indicador |
|---|---|
| 22701 | Transações correntes - saldo |
| 22707 | Balança comercial - saldo |
| 22708 | Exportação de bens |
| 22709 | Importação de bens |
| 22864 | Investimento direto - líquido |
| 22885 | Investimentos diretos no país (IDP) - líquido |
| 22905 | Investimentos em carteira - líquido |
| 22924 | Investimentos em carteira - passivos - líquido |
| 22969 | Outros investimentos - líquido |

A data de referência é o **primeiro dia do mês medido**, não a data de
publicação, que ocorre cerca de 25 dias após o fim do mês.

## Resultados de leilão no mesmo dia

O arquivo mensal não é a única divulgação. O Banco Central publica **cada
leilão de câmbio no mesmo dia**, como Comunicado numerado, e o site expõe o
texto completo por um endpoint JSON público:

```
https://www.bcb.gov.br/api/conteudo/app/normativos/exibeoutrasnormas
    ?p1=COMUNICADO&p2=<numero>
```

A página HTML do comunicado depende de JavaScript e não serve para leitura
automática; o endpoint acima devolve `Titulo`, `Data`, `DataTexto`, `Assunto` e
`Texto` em JSON.

Cada leilão gera, no mesmo dia, um par de comunicados:

- **Aviso de Abertura do Leilão de Câmbio N/AAAA**, com `Moeda`, `Natureza`
  (`Venda À vista`, `Compra À vista`, `Venda Conjugada com Compra Pós-Fixado
  Selic`) e `Data de Liquidação`;
- **Resultado do Leilão de Câmbio N/AAAA**, com a taxa de corte e o
  `valor total de USD $...` aceito.

Swaps seguem o mesmo padrão com `Leilão de Swap Cambial N/AAAA`, e o resultado
traz o nocional entre parênteses, em contratos e em dólares.

Verificação feita em 24/11/2026: o arquivo mensal cobria até 27/10/2026, mas os
comunicados já traziam 27 leilões posteriores, incluindo uma **venda à vista de
USD 1.000.000.000,00 em 19/11/2026**, comunicado 46.328, com liquidação em
24/11/2026. Sem essa fonte a aplicação afirmaria, erradamente, que o último
gasto tinha sido em 17/09/2026.

O coletor `collect_recent_auctions.py` lê esses comunicados, emparelha aviso e
resultado pelo número do leilão e publica apenas as operações posteriores à
cobertura do arquivo mensal, marcadas como provisórias. Um leilão cujo texto não
permita ler a natureza ou o valor fica registrado como não interpretado e não
entra em nenhum total.

### Limite conhecido do coletor de comunicados

O coletor reconhece leilões: "Aviso de Abertura do Leilão de Câmbio" e
"Aviso de Abertura do Leilão de Swap Cambial", com os respectivos resultados.
Ele **não** reconheceria uma "Operação Direta", que é uma atuação fora de
leilão e tem outro formato de divulgação.

Isso hoje não deixa buraco: a última operação direta do Banco Central foi em
**08/06/2020**, e desde então todas as atuações, sem exceção, são leilão
eletrônico. O risco existiria apenas se o Banco Central voltasse a operar
diretamente.

Há uma proteção automática. O teste
`test_the_communication_parser_reproduces_the_official_monthly_file` compara,
em toda data coberta pelas duas fontes, o que o coletor leu dos comunicados com
o que o arquivo mensal consolidado publica. Qualquer operação que o coletor
tenha deixado passar aparece como divergência assim que o arquivo mensal
alcançar aquela data.

### Observação sobre o número do comunicado no arquivo mensal

A coluna `Comunicado` do arquivo mensal aponta para o comunicado de
**condições da oferta**, publicado em geral às 18h30 do dia anterior, e não
para o comunicado de resultado. O aviso de abertura e o resultado saem no dia do
leilão, com números bem mais altos. Quem quiser casar as duas fontes deve fazê-lo
**pela data**, não pelo número do comunicado.

## O que não existe em formato aberto

### Composição das reservas por moeda e por classe de ativo

A busca por `composicao`, `ouro-reserva`, `direitos-especiais` e `des-fmi` no
catálogo completo retorna **zero** conjuntos de dados. A busca por `reservas`
retorna apenas as duas séries de total e dois conjuntos não relacionados.

A abertura existe somente em documentos:

- Relatório de Gestão das Reservas Internacionais (PDF, anual):
  <https://www.bcb.gov.br/publicacoes/relatoriogestaoreservas>
- Demonstrativo de reservas internacionais e liquidez em moeda estrangeira
  (template SDDS do FMI):
  <https://www.bcb.gov.br/estatisticas/reservasinternacionaisliquidezmoedaestrangeira>

A aplicação registra essa ausência em `data/composition/composition.json`,
reverifica o catálogo a cada coleta e **não exibe percentuais estimados**. Se o
Banco Central passar a publicar, o teste `test_composition_is_still_absent_from_the_open_catalogue`
falha e avisa.

### Fluxo cambial contratado semanal

A busca por `contratado` no catálogo retorna **zero** conjuntos de dados. O
fluxo cambial comercial e financeiro divulgado na nota do setor externo não tem
série no SGS nem serviço OData.

A página de fluxo usa o balanço de pagamentos mensal, que é um conceito
diferente, e declara isso em texto fixo na própria página e no arquivo de dados.

### Dívida externa de curto prazo em dólares

A série SGS 28192 existe, mas sua unidade declarada é **milhões de reais** e ela
mede a dívida externa total, não o curto prazo. Portanto não serve para a razão
"reservas sobre dívida externa de curto prazo". O componente correspondente do
indicador de pressão fica com peso zero e a razão da indisponibilidade aparece
na interface.

### Horário de execução das intervenções

O conjunto de dados traz `Data Hora Comunicado` e `Data Hora Anúncio`, que são
horários de **divulgação**, não de execução do leilão. Não há série intradiária
gratuita e confiável de câmbio para o horário das operações, por isso a análise
de efetividade usa fechamentos diários da PTAX e informa essa limitação.

## Fonte secundária usada no navegador

Para a cotação ao vivo do dólar comercial, que o Banco Central não publica:

- `https://economia.awesomeapi.com.br/json/last/USD-BRL`
- CORS liberado (`access-control-allow-origin: *`), sem chave, gratuita
- Consultada **pelo navegador**, nunca gravada no repositório
- Sempre identificada na interface como fonte secundária

## Endpoints verificados e descartados

| Endpoint testado | Resultado |
|---|---|
| `olinda.bcb.gov.br/olinda/servico/Mercado_Cambio_Atuacoes/versao/v1/odata/$metadata` | HTTP 404, serviço não existe |
| `olinda.bcb.gov.br/olinda/servico/Mercado_Cambio_Fluxos/versao/v1/odata/$metadata` | HTTP 404, serviço não existe |
| `bcb.gov.br/content/publicacoes/leiloes/resultado-leilao-cambio` | HTTP 404 |
| `api.bcb.gov.br/dados/serie/bcdata.sgs.13621/dados?dataInicial=01/01/1990` | HTTP 406, janela acima de dez anos |
