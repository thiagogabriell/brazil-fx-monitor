/* Configurações: preferences kept in LocalStorage only. */
'use strict';

window.PAGE = (() => {
  function storageTable() {
    const body = document.getElementById('storage-body');
    const rows = [];
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key || !key.startsWith('bfx:')) continue;
        rows.push([key.slice(4), window.localStorage.getItem(key)]);
      }
    } catch (error) {
      body.innerHTML = '<tr><td colspan="3" class="na">O navegador bloqueou o acesso ao armazenamento local.</td></tr>';
      return;
    }
    body.innerHTML = rows.length
      ? rows.sort().map(([key, value]) => `<tr>
          <td class="num">${BFX.escapeHtml(key)}</td>
          <td class="wrap num">${BFX.escapeHtml(value.length > 300 ? value.slice(0, 300) + '…' : value)}</td>
          <td><button class="btn" type="button" data-forget="${BFX.escapeHtml(key)}">apagar</button></td>
        </tr>`).join('')
      : '<tr><td colspan="3" class="card__meta-row">Nada guardado ainda.</td></tr>';

    body.querySelectorAll('[data-forget]').forEach((button) => {
      button.addEventListener('click', () => {
        BFX.forget(button.dataset.forget);
        storageTable();
      });
    });
  }

  function notificationState() {
    const element = document.getElementById('notification-state');
    if (!('Notification' in window)) {
      element.innerHTML = '<span class="na">Este navegador não suporta notificações.</span>';
      return;
    }
    const map = {
      granted: '<span class="pos">permitidas</span>',
      denied: '<span class="neg">bloqueadas no navegador</span>',
      default: '<span class="neutral">ainda não solicitadas</span>'
    };
    element.innerHTML = 'Permissão atual: ' + map[Notification.permission];
  }

  async function init() {
    const theme = document.getElementById('theme-select');
    theme.value = BFX.currentTheme();
    theme.addEventListener('change', () => { BFX.applyTheme(theme.value); storageTable(); });

    const concept = document.getElementById('default-concept');
    concept.value = BFX.recall('defaultConcept', 'cash');
    concept.addEventListener('change', () => {
      BFX.store('defaultConcept', concept.value);
      storageTable();
    });

    const range = document.getElementById('default-range');
    range.innerHTML = BFX.RANGES.filter((item) => item.key !== 'custom')
      .map((item) => `<option value="${item.key}">${BFX.escapeHtml(item.label)}</option>`).join('');
    range.value = BFX.recall('defaultRange', '1y');
    range.addEventListener('change', () => {
      BFX.store('defaultRange', range.value);
      storageTable();
    });

    const pageSize = document.getElementById('page-size');
    pageSize.value = String(BFX.recall('pageSize', 100));
    pageSize.addEventListener('change', () => {
      BFX.store('pageSize', Number(pageSize.value));
      storageTable();
    });

    const liveEnabled = document.getElementById('live-enabled');
    liveEnabled.value = String(BFX.recall('liveQuote', true));
    liveEnabled.addEventListener('change', () => {
      BFX.store('liveQuote', liveEnabled.value === 'true');
      storageTable();
    });

    const liveInterval = document.getElementById('live-interval');
    liveInterval.value = String(BFX.recall('liveQuoteInterval', 60));
    liveInterval.addEventListener('change', () => {
      BFX.store('liveQuoteInterval', Math.max(15, Number(liveInterval.value) || 60));
      storageTable();
    });

    document.getElementById('request-permission').addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      try { await Notification.requestPermission(); } catch (error) { /* ignore */ }
      notificationState();
    });

    document.getElementById('test-notification').addEventListener('click', () => {
      if (!('Notification' in window) || Notification.permission !== 'granted') {
        notificationState();
        return;
      }
      try {
        new Notification('Brazil FX Monitor', {
          body: 'Notificação de teste. As notificações reais só aparecem com o painel aberto.'
        });
      } catch (error) { /* ignore */ }
    });

    document.getElementById('clear-storage').addEventListener('click', () => {
      try {
        const keys = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (key && key.startsWith('bfx:')) keys.push(key);
        }
        keys.forEach((key) => window.localStorage.removeItem(key));
      } catch (error) { /* ignore */ }
      storageTable();
    });

    notificationState();
    storageTable();
  }

  return { init };
})();
