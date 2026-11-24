/* ECharts helpers: one theme, one tooltip style, one export path. */
'use strict';

const BFXCharts = (() => {
  const registry = new Map();

  function palette() {
    const style = getComputedStyle(document.documentElement);
    const read = (name, fallback) =>
      (style.getPropertyValue(name) || fallback).trim();
    return {
      text: read('--text', '#e6ebf4'),
      muted: read('--text-muted', '#8e9bb3'),
      dim: read('--text-dim', '#5e6b83'),
      border: read('--border', '#232c3d'),
      card: read('--bg-card', '#141925'),
      raised: read('--bg-raised', '#11151f'),
      inflow: read('--inflow', '#2ecc71'),
      outflow: read('--outflow', '#ff5c5c'),
      warn: read('--warn', '#f5c542'),
      info: read('--info', '#4a9eff'),
      notional: read('--notional', '#b07cff'),
      unavailable: read('--unavailable', '#6b7689')
    };
  }

  function baseOption() {
    const colors = palette();
    return {
      backgroundColor: 'transparent',
      animationDuration: 260,
      textStyle: { color: colors.muted, fontFamily: 'inherit', fontSize: 11 },
      grid: { left: 62, right: 26, top: 34, bottom: 48, containLabel: true },
      legend: {
        type: 'scroll',
        top: 2,
        textStyle: { color: colors.muted, fontSize: 11 },
        inactiveColor: colors.dim,
        icon: 'roundRect',
        itemWidth: 11,
        itemHeight: 7
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.raised,
        borderColor: colors.border,
        borderWidth: 1,
        textStyle: { color: colors.text, fontSize: 12 },
        axisPointer: { type: 'cross', label: { backgroundColor: colors.border } },
        confine: true
      },
      toolbox: {
        right: 6,
        top: 0,
        iconStyle: { borderColor: colors.dim },
        emphasis: { iconStyle: { borderColor: colors.info } },
        feature: {
          dataZoom: { yAxisIndex: 'none', title: { zoom: 'Zoom', back: 'Desfazer zoom' } },
          restore: { title: 'Restaurar' },
          saveAsImage: { title: 'Exportar imagem', pixelRatio: 2, backgroundColor: colors.card }
        }
      },
      dataZoom: [
        { type: 'inside', throttle: 40 },
        {
          type: 'slider',
          height: 16,
          bottom: 8,
          borderColor: colors.border,
          fillerColor: 'rgba(74,158,255,0.12)',
          handleStyle: { color: colors.info },
          textStyle: { color: colors.dim, fontSize: 10 }
        }
      ],
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: colors.border } },
        axisLabel: { color: colors.dim, hideOverlap: true },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: colors.dim },
        splitLine: { lineStyle: { color: colors.border, type: 'dashed' } }
      }
    };
  }

  function merge(target, source) {
    Object.keys(source || {}).forEach((key) => {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        target[key] = merge(Object.assign({}, target[key] || {}), value);
      } else {
        target[key] = value;
      }
    });
    return target;
  }

  function create(elementId, option) {
    const element = document.getElementById(elementId);
    if (!element) return null;
    if (typeof echarts === 'undefined') {
      element.innerHTML = '<p class="notice notice--warn">A biblioteca de gráficos ' +
        'não pôde ser carregada. Os dados continuam disponíveis nas tabelas e na ' +
        'exportação.</p>';
      return null;
    }
    let chart = registry.get(elementId);
    if (!chart) {
      chart = echarts.init(element, null, { renderer: 'canvas' });
      registry.set(elementId, chart);
      window.addEventListener('resize', () => chart.resize());
    }
    chart.setOption(merge(baseOption(), option), { notMerge: true });
    return chart;
  }

  function reskin() {
    registry.forEach((chart) => {
      const option = chart.getOption();
      const refreshed = merge(baseOption(), {
        series: option.series,
        xAxis: option.xAxis,
        yAxis: option.yAxis,
        legend: option.legend ? [{ data: option.legend[0] && option.legend[0].data }] : undefined
      });
      chart.setOption(refreshed);
    });
  }

  window.addEventListener('bfx:theme', () => setTimeout(reskin, 20));

  /* Formatters used inside tooltips and axes. */
  const fmt = {
    usdBillions: (value) => (value === null || value === undefined
      ? BFX.naText()
      : 'US$ ' + new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value / 1e9) + ' bi'),
    usdMillions: (value) => (value === null || value === undefined
      ? BFX.naText()
      : 'US$ ' + new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value / 1e6) + ' mi'),
    plainMillions: (value) => (value === null || value === undefined
      ? BFX.naText()
      : 'US$ ' + new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value) + ' mi'),
    brl: (value) => BFX.brl(value, 4),
    pct: (value) => BFX.pct(value)
  };

  /** Mark dates on a time axis, used to show interventions over a price line. */
  function markLines(dates, color, name) {
    return {
      symbol: 'none',
      silent: true,
      lineStyle: { color, width: 1, type: 'dashed', opacity: 0.55 },
      label: { show: false },
      data: dates.map((date) => ({ xAxis: date, name }))
    };
  }

  return { create, palette, baseOption, fmt, markLines, reskin, registry };
})();

window.BFXCharts = BFXCharts;
