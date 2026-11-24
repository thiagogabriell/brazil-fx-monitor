# Metodologia

## Unidades e precisão

- Saldos de reservas: inteiros em **dólares**. A fonte publica em milhões; a
  conversão usa `Decimal` para não introduzir erro de ponto flutuante.
- Volumes de operações: inteiros em **centavos de dólar**. A divisão por 100
  acontece só na apresentação. Isso elimina o erro clássico de somar centenas de
  valores com duas casas decimais em ponto flutuante.
- Taxas de câmbio: reais por dólar, como publicado.
- Balanço de pagamentos: US$ milhões, como publicado.

Toda unidade é declarada no próprio arquivo JSON (`unit`, `source_unit`).

## Datas

Quatro datas são distinguidas e nunca confundidas:

| Data | O que é |
|---|---|
| Data do evento | quando a operação foi negociada (`Data`) |
| Data de liquidação | quando a moeda estrangeira muda de mãos (`Data de Liquidação`) |
| Data de publicação | quando o Banco Central divulgou (`Data Hora Comunicado`) |
| Data da coleta | quando esta aplicação leu a fonte (`collected_at`) |

Os horários publicados pelo Banco Central são relógio de parede de São Paulo,
sem offset, e são exibidos exatamente como vieram. Os carimbos gerados por esta
aplicação são UTC e convertidos para America/Sao_Paulo na interface.

## Conciliação diária das reservas

Para cada data com saldo publicado:

```
saldo inicial = saldo da data útil anterior publicada
saldo final   = saldo da data
variação      = saldo final - saldo inicial
```

Operações são atribuídas à data em que a moeda realmente se move:

- **data de liquidação** para vendas e compras;
- **data de vencimento** para o retorno de operações temporárias;
- **data da operação** para swaps, que não movem reservas.

Conceito caixa:

```
variação explicada = compras + retorno de temporárias
                   - vendas  - saída de temporárias
```

Conceito liquidez: o Banco Central não divulga o efeito de cada operação
temporária nesse conceito, portanto elas **não** são subtraídas. Aparecem ao
lado do extrato, com o efeito marcado como não divulgado.

```
variação não identificada = variação - variação explicada
```

Esse resíduo contém rendimentos dos investimentos, variação cambial entre
moedas, marcação de ouro e de títulos e qualquer outro movimento que o Banco
Central não divulga por dia. **Nenhuma causa é atribuída a ele.**

Dias posteriores à cobertura da fonte de atuações recebem
`interventions_coverage: "not_yet_published"` e têm variação explicada e
resíduo nulos, para não sugerir ausência de intervenção.

## Classificação das operações

Derivada exclusivamente das colunas `Instrumento` e `Modalidade`:

| Categoria | Efeito | Nocional | Temporária |
|---|---|---|---|
| `spot_sale` | reduz | não | não |
| `spot_purchase` | aumenta | não | não |
| `forward_purchase` | aumenta | não | não |
| `sale_with_repurchase` | reduz temporariamente | não | sim |
| `repurchase_agreement` | reduz temporariamente | não | sim |
| `loan` | reduz temporariamente | não | sim |
| `swap_traditional` | nenhum | sim | não |
| `swap_reverse` | nenhum | sim | não |

Um instrumento ou modalidade desconhecido **não** é encaixado numa categoria
próxima: a operação é reportada como não mapeada, o coletor termina com código
de saída 2 e o estado da coleta registra o problema.

## Status das operações

| Status | Critério |
|---|---|
| `pendente_de_confirmacao` | sem volume aceito publicado |
| `anunciada` | volume aceito igual a zero |
| `realizada` | volume aceito maior que zero, liquidação no futuro |
| `liquidada` | volume aceito maior que zero, liquidação já ocorrida |

`cancelada` não existe: a fonte declara que não reflete cancelamentos.

## Identificadores estáveis

`sha256` dos quinze campos publicados, truncado em 16 caracteres, mais um índice
de ocorrência que separa linhas que a fonte publica de forma idêntica. O
identificador só muda quando o conteúdo publicado da operação muda.

## Efetividade das intervenções

Para cada venda direta com resultado publicado, compara a PTAX de fechamento:

- do dia útil anterior,
- do dia da operação,
- do dia útil seguinte,
- de cinco dias úteis depois.

Classificação, com banda de estabilidade de ±0,25% definida por esta aplicação:

- real se valorizou (queda da PTAX),
- real permaneceu relativamente estável,
- real continuou se desvalorizando,
- dados insuficientes.

Correlação não é causalidade: outros fatores movem o câmbio no mesmo período e a
comparação não isola o efeito da intervenção.

## Indicador de pressão cambial

Metodologia experimental desta aplicação, de 0 a 100.

```
score = Σ(sub_score_i × peso_i) / Σ(peso_i)
```

somando apenas os componentes com dado disponível. Cada `sub_score` vem de uma
função linear por partes com pontos de quebra declarados no código e exibidos na
interface.

| Componente | Peso |
|---|---|
| Velocidade de redução das reservas (30 dias) | 12 |
| Velocidade de redução das reservas (90 dias) | 7 |
| Frequência de vendas diretas (30 dias) | 12 |
| Volume vendido sobre as reservas (90 dias) | 12 |
| Aceleração das intervenções | 9 |
| Velocidade de desvalorização do real (30 dias) | 12 |
| Velocidade de desvalorização do real (90 dias) | 5 |
| Saída líquida de dólares (conta financeira, 3 meses) | 9 |
| Persistência da alta do dólar após intervenções | 9 |
| Operações temporárias em aberto | 6 |
| Cobertura das importações pelas reservas | 7 |
| Reservas sobre dívida externa de curto prazo | 0 (sem dado oficial) |

Soma dos pesos previstos: 100. Abaixo de **60% de cobertura** a pontuação não é
publicada, para não aparentar precisão que os dados não sustentam.

Faixas: 0-20 Normal · 21-40 Atenção · 41-60 Pressão elevada · 61-80 Pressão
severa · 81-100 Pressão crítica.

Não é classificação oficial do Banco Central, não é previsão de crise e não é
recomendação financeira.

## Alertas

Dezesseis regras com limites configuráveis. As rotinas automáticas avaliam
apenas os limites padrão e gravam o histórico no repositório. No navegador o
usuário pode usar limites próprios, guardados no LocalStorage deste dispositivo.

A regra de fonte desatualizada usa uma tolerância por fonte, calibrada pela
periodicidade real de cada uma, para não disparar durante o intervalo normal de
publicação.

Os limites são critérios de monitoramento desta aplicação, não indicadores
oficiais de crise.

## Simulador

Aritmética sobre o saldo informado, em dias corridos, com a saída diária
derivada das intervenções por semana e do volume adicional por dia útil. Não
modela juros, variação cambial, marcação de ativos nem disponibilidade dos
ativos. É simulação matemática, não previsão econômica, e a interface diz que
não se deve supor que todo o saldo esteja imediatamente disponível para
intervenções.
