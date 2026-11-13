/* POS Discoteca — PWA offline. O Apps Script é só a API; as vendas ficam numa fila local
   (localStorage) e são enviadas com uma chave única, para que reenviar nunca duplique. */
(function () {
  'use strict';
  var LS = window.localStorage;
  function ler(k, d) { try { var v = LS.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function gravar(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) { toast('Memória do telemóvel cheia: sincronize e limpe vendas enviadas.', true); } }
  function $(s, e) { return (e || document).querySelector(s); }
  function $$(s, e) { return Array.prototype.slice.call((e || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('fr-FR'); }
  function chave() { return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  var S = {
    url: ler('pos_url', ''), sess: ler('pos_sess', null), boot: ler('pos_boot', null), refs: ler('pos_refs', null), caixa: ler('pos_caixa', null),
    fila: ler('pos_fila', []), mesas: ler('pos_mesas', []), mesasHora: ler('pos_mesas_hora', 0), mesaAtiva: null, dev: ler('pos_dev', null), seq: ler('pos_seq', 0), cart: [], cat: '', q: '', online: navigator.onLine, aSincronizar: false
  };
  if (!S.dev) { S.dev = 'T' + Math.random().toString(36).slice(2, 5).toUpperCase(); gravar('pos_dev', S.dev); }

  function toast(m, erro) {
    var t = document.createElement('div'); t.className = 'toast'; t.style.color = erro ? '#fecaca' : ''; t.textContent = m; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, erro ? 6000 : 2800);
  }
  function guardarFila() { gravar('pos_fila', S.fila); }

  /* ---------- rede ---------- */
  function chamar(acao, payload) {
    if (!S.url) return Promise.reject(new Error('Falta o endereço do servidor.'));
    var ctrl = new AbortController(), tm = setTimeout(function () { ctrl.abort(); }, 20000);
    return fetch(S.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: S.sess ? S.sess.token : null, acao: acao, payload: payload || {} }), signal: ctrl.signal, redirect: 'follow' })
      .then(function (r) { clearTimeout(tm); return r.text(); }, function (e) { clearTimeout(tm); S.online = false; var er = new Error('Sem ligação ao servidor (' + (e && e.name === 'AbortError' ? 'demorou demasiado' : 'a rede ou o acesso "Qualquer pessoa" do Apps Script pode estar a falhar') + ').'); er.rede = true; throw er; })
      .then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) {
          S.online = false; var er = new Error('O servidor respondeu algo inesperado. Confirme no Apps Script: implantação "Qualquer pessoa" e Nova versão com o Code.gs mais recente (tem de ter doPost). Início da resposta: ' + String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140));
          er.rede = true; throw er;
        }
        S.online = true;
        if (!j.ok) { var e2 = new Error(j.erro || 'Erro'); e2.servidor = true; throw e2; }
        return j.data;
      });
  }

  /* ---------- cálculo (igual ao servidor) ---------- */
  function prod(id) { return ((S.refs && S.refs.produtos) || []).filter(function (p) { return p.id === id; })[0]; }
  function totais(itens, desc) {
    var sub = 0; itens.forEach(function (i) { var p = prod(i.produtoId); sub += Math.round((p ? p.precoVenda : 0) * i.qtd); });
    var base = Math.max(sub - (desc || 0), 0), cf = (S.boot && S.boot.cfg) || {}, t = Number(cf.IGV_TAXA) || 0, igv, total;
    if (String(cf.PRECOS_COM_IGV) !== 'Não') { igv = Math.round(base * t / (100 + t)); total = base; } else { igv = Math.round(base * t / 100); total = base + igv; }
    return { sub: sub, igv: igv, total: total };
  }

  /* ---------- fila e sincronização ---------- */
  function pendentes() { return S.fila.filter(function (v) { return v.estado === 'pendente'; }); }
  function comErro() { return S.fila.filter(function (v) { return v.estado === 'erro'; }); }
  function sincronizar(silencioso) {
    if (S.aSincronizar || !S.sess) return Promise.resolve();
    var lista = pendentes(); if (!lista.length) return Promise.resolve();
    S.aSincronizar = true; barra();
    var i = 0;
    function prox() {
      if (i >= lista.length) return Promise.resolve();
      var v = lista[i++];
      var req = v.tipo === 'pedido' ? chamar('mesa_pedido', { chave: v.chave, id: v.mesaId || '', mesa: v.mesa, itens: v.itens }) : chamar('venda_guardar', { chave: v.chave, estado: 'Paga', itens: v.itens, pagamentos: v.pagamentos, mesa: v.mesa || '', desconto: 0 });
      return req.then(function (r) {
        v.estado = 'enviada';
        if (v.tipo === 'pedido') { v.num = 'Pedido ' + r.pedido + ' · mesa ' + r.mesa; if (v.mesaId && r.id !== v.mesaId) v.aviso = 'A mesa já tinha sido cobrada: abriu-se uma conta nova.'; } else v.num = r.num;
        guardarFila(); return prox();
      }, function (e) {
        if (e.rede) throw e;
        if (/Sess[aã]o expirada/i.test(e.message)) { var er = new Error(e.message); er.sessao = true; throw er; }
        v.estado = 'erro'; v.erro = e.message; guardarFila(); return prox();
      });
    }
    return prox().then(function () { if (!silencioso) toast('Sincronização concluída.'); }, function (e) {
      if (e.sessao) { S.sess = null; gravar('pos_sess', null); toast('Sessão expirada: entre de novo para enviar as vendas pendentes.', true); render(); }
      else if (!silencioso) toast('Sem ligação: as vendas ficam guardadas.', true);
    }).then(function () { S.aSincronizar = false; barra(); return atualizar(true); });
  }
  function atualizar(silencioso) {
    if (!S.sess) return Promise.resolve();
    return Promise.all([chamar('bootstrap', {}), chamar('refs', {}), chamar('caixa_estado', {}), chamar('mesas_abertas', {})]).then(function (r) {
      S.boot = r[0]; S.refs = r[1]; S.caixa = r[2]; S.mesas = r[3].rows; S.mesasResumo = r[3].resumo; S.mesasHora = Date.now(); gravar('pos_mesas', S.mesas); gravar('pos_mesas_hora', S.mesasHora); gravar('pos_boot', S.boot); gravar('pos_refs', S.refs); gravar('pos_caixa', S.caixa); gravar('pos_hora', Date.now());
      if (!silencioso) toast('Dados atualizados.'); render();
    }).catch(function (e) { if (e.servidor && /Sess[aã]o expirada/i.test(e.message)) { S.sess = null; gravar('pos_sess', null); render(); } barra(); });
  }

  /* ---------- ecrãs ---------- */
  var raiz = $('#app');
  function render() {
    if (!S.url) return ecraUrl();
    if (!S.sess) return ecraLogin();
    ecraPos();
  }
  function ecraUrl() {
    raiz.innerHTML = '<div class="center card"><h2>Ligar ao servidor</h2><p class="mut">Cole o endereço da aplicação do Apps Script (termina em /exec).</p><div class="f"><input id="u" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(S.url) + '"></div><button id="ok" style="width:100%">Guardar</button></div>';
    $('#ok').onclick = function () { var v = $('#u').value.trim(); if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(v)) return toast('Endereço inválido.', true); S.url = v; gravar('pos_url', v); render(); };
  }
  function ecraLogin() {
    raiz.innerHTML = '<div class="center card"><h2>POS Discoteca</h2>' + (pendentes().length ? '<div class="note">Há ' + pendentes().length + ' venda(s) por enviar. Entre para as sincronizar.</div>' : '') + '<div class="f"><label>Utilizador</label><input id="lu" autocapitalize="none" autocomplete="username"></div><div class="f"><label>PIN</label><input id="lp" type="password" inputmode="numeric" autocomplete="current-password"></div><button id="lg" style="width:100%">Entrar</button><p class="mut" style="margin-top:14px"><a href="#" id="cu" style="color:var(--mut)">Alterar servidor</a></p></div>';
    $('#cu').onclick = function (e) { e.preventDefault(); ecraUrl(); };
    $('#lg').onclick = function () {
      var b = this; b.disabled = true;
      chamar('login', { utilizador: $('#lu').value, pin: $('#lp').value }).then(function (r) {
        S.sess = r; gravar('pos_sess', r); return atualizar(true);
      }).then(function () { render(); sincronizar(true); }).catch(function (e) { b.disabled = false; toast(e.message, true); });
    };
  }
  function barra() {
    var el = $('#bar'); if (!el) return;
    var p = pendentes().length, er = comErro().length;
    el.innerHTML = '<b>' + esc((S.boot && S.boot.cfg && S.boot.cfg.EMPRESA) || 'POS') + '</b><span class="dot ' + (S.online ? 'on' : '') + '"></span><span class="mut">' + (S.online ? 'online' : 'offline') + '</span><span class="sp"></span>' +
      (p ? '<span class="badge">' + p + ' por enviar</span>' : '') + (er ? '<span class="badge" style="background:var(--bad);color:#fff">' + er + ' com erro</span>' : '') +
      '<button class="sec" id="bs">' + (S.aSincronizar ? 'A enviar…' : 'Sincronizar') + '</button><button class="sec" id="bm">Mesas</button><button class="sec" id="bf">Vendas</button><button class="sec" id="bx">Sair</button>';
    faixa();
    $('#bs').onclick = function () { sincronizar(false); };
    $('#bm').onclick = ecraMesas;
    $('#bf').onclick = ecraFila;
    $('#bx').onclick = function () {
      if (pendentes().length && !confirm('Há vendas por enviar. Elas ficam guardadas neste aparelho, mas só serão enviadas quando entrar de novo. Sair?')) return;
      S.sess = null; gravar('pos_sess', null); S.cart = []; render();
    };
  }
  function cashLocal() {
    var s = 0; pendentes().forEach(function (v) { (v.pagamentos || []).forEach(function (p) { if (p.forma === 'NUMERARIO') s += p.valor; }); }); return s;
  }
  function ecraPos() {
    var cx = S.caixa && S.caixa.aberta, k = S.caixa && S.caixa.calc;
    var lim = Number(S.boot && S.boot.cfg && S.boot.cfg.LIMITE_RECOLHA) || 0;
    var alerta = '';
    if (cx && cx.tipo === 'INDIVIDUAL' && k) {
      var est = k.esperado + cashLocal();
      if ((lim && est >= lim) || k.alertaValor || k.alertaTempo) alerta = '<div class="note err" style="margin:12px">Recolha necessária: ' + fmt(est) + ' FCFA em numerário. Peça uma recolha à caixa central (no sistema principal).</div>';
    }
    var hora = ler('pos_hora', 0);
    raiz.innerHTML = '<div class="top" id="bar"></div>' + alerta +
      (!cx ? '<div class="note err" style="margin:12px">Sem caixa aberta (nos últimos dados recebidos). Peça ao gerente para abrir a sua caixa e carregue em Sincronizar.</div>' : '') +
      (!S.online && hora ? '<div class="note" style="margin:12px">Modo offline. Preços e produtos de ' + new Date(hora).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) + '. As vendas serão enviadas quando houver rede.</div>' : '') +
      '<div id="faixa"></div><div class="wrap"><div><input id="q" placeholder="Procurar produto…"><div class="cats" id="cats"></div><div class="grid" id="gr"></div></div><div class="card cart" id="cart" style="margin:0"></div></div>';
    $('#q').oninput = function () { S.q = this.value.toLowerCase(); grelha(); };
    barra(); cats(); grelha(); carrinho();
  }
  function cats() {
    var cs = [], v = {}; ((S.refs && S.refs.produtos) || []).forEach(function (p) { if (!v[p.categoria]) { v[p.categoria] = 1; cs.push(p.categoria); } });
    $('#cats').innerHTML = '<span class="chip ' + (S.cat === '' ? 'on' : '') + '" data-c="">Todos</span>' + cs.map(function (c) { return '<span class="chip ' + (S.cat === c ? 'on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</span>'; }).join('');
    $$('#cats .chip').forEach(function (e) { e.onclick = function () { S.cat = e.getAttribute('data-c'); cats(); grelha(); }; });
  }
  function grelha() {
    var l = ((S.refs && S.refs.produtos) || []).filter(function (p) { return (!S.cat || p.categoria === S.cat) && (!S.q || p.nome.toLowerCase().indexOf(S.q) >= 0); });
    $('#gr').innerHTML = l.map(function (p) { return '<div class="prod" data-id="' + p.id + '"><b>' + esc(p.nome) + '</b><span>' + fmt(p.precoVenda) + ' FCFA</span></div>'; }).join('') || '<p class="mut">Sem produtos (carregue em Sincronizar com ligação).</p>';
    $$('#gr .prod').forEach(function (e) { e.onclick = function () { add(e.getAttribute('data-id'), 1); }; });
  }
  function add(id, d) {
    var l = S.cart.filter(function (i) { return i.produtoId === id; })[0];
    if (l) { l.qtd += d; if (l.qtd <= 0) S.cart = S.cart.filter(function (i) { return i !== l; }); } else if (d > 0) S.cart.push({ produtoId: id, qtd: d });
    carrinho();
  }
  function carrinho() {
    var t = totais(S.cart, 0), ma = S.mesaAtiva;
    $('#cart').innerHTML = (ma ? '<h3 style="margin-top:0">Mesa ' + esc(ma.mesa) + '</h3>' + jaPedido(ma) : '<h3 style="margin-top:0">Venda</h3>') + (S.cart.length ? S.cart.map(function (i) {
      var p = prod(i.produtoId) || { nome: '?', precoVenda: 0 };
      return '<div class="l"><div style="flex:1"><b>' + esc(p.nome) + '</b><div class="mut">' + fmt(p.precoVenda * i.qtd) + '</div></div><div class="q"><button class="sec" data-m="' + i.produtoId + '">−</button><b>' + i.qtd + '</b><button class="sec" data-p="' + i.produtoId + '">+</button></div></div>';
    }).join('') : '<p class="mut">Toque nos produtos para adicionar.</p>') +
      '<div class="total">' + fmt(t.total) + ' FCFA</div>' +
      (ma ? '<div class="row"><button class="sec" id="lm">Sair da mesa</button><button class="sec" id="ep">Enviar pedido</button><button id="cb">Cobrar mesa</button></div><p class="mut" style="font-size:12px">Cobrar a mesa precisa de internet.</p>'
          : '<div class="row"><button class="sec" id="lm">Limpar</button><button class="sec" id="mz">Mesas</button><button id="cb">Cobrar</button></div>');
    $$('[data-m]').forEach(function (b) { b.onclick = function () { add(b.getAttribute('data-m'), -1); }; });
    $$('[data-p]').forEach(function (b) { b.onclick = function () { add(b.getAttribute('data-p'), 1); }; });
    $('#lm').onclick = function () { S.cart = []; S.mesaAtiva = null; carrinho(); };
    if ($('#mz')) $('#mz').onclick = ecraMesas;
    if (ma) { $('#ep').onclick = enviarPedido; $('#cb').onclick = cobrarMesa; } else $('#cb').onclick = cobrar;
  }
  function chaveMesa(n) { return String(n || '').trim().toLowerCase(); }
  function linhasMesa(m) {
    var l = (m.linhas || []).map(function (x) { return { nome: x.nome, qtd: x.qtd, quem: x.pedidoPor, pend: false }; });
    S.fila.forEach(function (v) {
      if (v.tipo === 'pedido' && v.estado !== 'enviada' && ((v.mesaId && v.mesaId === m.id) || (!v.mesaId && chaveMesa(v.mesa) === chaveMesa(m.mesa)))) {
        v.snap.forEach(function (i) { l.push({ nome: i.nome, qtd: i.qtd, quem: v.operador, pend: true }); });
      }
    });
    return l;
  }
  function jaPedido(m) {
    var l = linhasMesa(m);
    return '<div class="note" style="margin:6px 0"><b>Já pedido</b>' + (l.length ? l.map(function (x) { return '<div style="font-size:13px">' + x.qtd + '× ' + esc(x.nome) + ' <span class="mut">· ' + esc(x.quem || '') + (x.pend ? ' (por enviar)' : '') + '</span></div>'; }).join('') : '<div class="mut" style="font-size:13px">Mesa nova.</div>') + '</div>';
  }
  function dur(m) { m = Math.max(0, Math.round(Number(m) || 0)); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h' + ('0' + (m % 60)).slice(-2); }
  function listaMesas() { // mesas do servidor + as que só existem neste aparelho (pedido por enviar)
    var dec = S.mesasHora ? (Date.now() - S.mesasHora) / 60000 : 0, alerta = Number(S.boot && S.boot.cfg && S.boot.cfg.MESA_ALERTA_MIN) || 90;
    var lista = (S.mesas || []).map(function (m) { var x = Object.assign({}, m); x.minutos = (m.minutos || 0) + dec; x.minutosUltimo = (m.minutosUltimo || 0) + dec; x.parada = x.minutosUltimo >= alerta; return x; });
    S.fila.forEach(function (v) {
      if (v.tipo === 'pedido' && v.estado !== 'enviada') {
        var ex = lista.filter(function (m) { return (v.mesaId && m.id === v.mesaId) || chaveMesa(m.mesa) === chaveMesa(v.mesa); })[0];
        if (!ex) { ex = { id: '', mesa: v.mesa, operador: v.operador, total: 0, linhas: [], nova: true, minutos: 0, minutosUltimo: 0, nPedidos: 0 }; lista.push(ex); }
        ex.pend = (ex.pend || 0) + 1;
      }
    });
    return lista;
  }
  function minha(m) { var u = S.sess && S.sess.user || {}; return m.nova || !m.operador || m.operador === u.nome || u.papel === 'GERENTE' || u.papel === 'ADMIN'; }
  function abrirDaLista(x) {
    if (!minha(x)) return toast('A mesa ' + x.mesa + ' está a cargo de ' + x.operador + '. Só ele (ou o gerente) lança pedidos; peça a transferência no sistema principal.', true);
    S.mesaAtiva = { id: x.id, mesa: x.mesa, linhas: x.linhas || [] }; S.cart = []; carrinho();
  }
  function faixa() {
    var el = $('#faixa'); if (!el) return;
    var l = listaMesas();
    if (!l.length) { el.innerHTML = ''; return; }
    var tot = l.reduce(function (a, m) { return a + (Number(m.total) || 0); }, 0), par = l.filter(function (m) { return m.parada; }).length;
    el.innerHTML = '<div class="note" style="margin:8px 12px"><div class="mut" style="margin-bottom:6px"><b>' + l.length + ' mesa(s) aberta(s)</b> · ' + fmt(tot) + ' FCFA' + (par ? ' · <span style="color:var(--bad)">' + par + ' parada(s)</span>' : '') + (S.mesasHora ? ' · atualizado às ' + new Date(S.mesasHora).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : '') + '</div><div class="cats" style="padding:0">' +
      l.map(function (m, ix) { return '<span class="chip" data-fm="' + ix + '"' + (m.parada ? ' style="outline:2px solid var(--bad)"' : '') + '><b>' + esc(m.mesa) + '</b> ' + fmt(m.total) + (m.nova ? '' : ' · ' + dur(m.minutosUltimo)) + (m.pend ? ' ⏳' : '') + '</span>'; }).join('') + '</div></div>';
    $$('#faixa [data-fm]').forEach(function (c) { c.onclick = function () { abrirDaLista(l[Number(c.getAttribute('data-fm'))]); }; });
  }
  function ecraMesas() {
    var lista = listaMesas();
    modal('<h3 style="margin-top:0">Mesas abertas</h3>' + (S.online ? '' : '<p class="mut">Offline: lista de ' + (S.mesasHora ? new Date(S.mesasHora).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : 'última sincronização') + '.</p>') + (lista.length ? '<table>' + lista.map(function (m, ix) {
      return '<tr><td><b>' + esc(m.mesa) + '</b>' + (m.parada ? ' <span style="color:var(--bad)">parada</span>' : '') + '<div class="mut">' + 'servidor: ' + esc(m.operador || '') + (m.nova ? ' · só neste aparelho' : ' · aberta há ' + dur(m.minutos) + ' · ' + (m.nPedidos || 0) + ' pedido(s) · último há ' + dur(m.minutosUltimo)) + (m.pend ? ' · ' + m.pend + ' por enviar' : '') + '</div></td><td style="text-align:right">' + fmt(m.total) + '</td><td><button data-ix="' + ix + '">Abrir</button></td></tr>';
    }).join('') + '</table>' : '<p class="mut">Não há mesas abertas.</p>') + '<div class="f" style="margin-top:12px"><label>Nova mesa</label><input id="nm" placeholder="nome ou número"></div><div class="row acts"><button class="sec" id="mx">Fechar</button><button id="mk">Abrir mesa</button></div>', function (m) {
      $('#mx', m).onclick = function () { m.remove(); };
      $$('[data-ix]', m).forEach(function (b) { b.onclick = function () { var x = lista[Number(b.getAttribute('data-ix'))]; if (!minha(x)) return abrirDaLista(x); m.remove(); abrirDaLista(x); }; });
      $('#mk', m).onclick = function () {
        var n = $('#nm', m).value.trim(); if (!n) return toast('Indique o nome da mesa.', true);
        var ex = lista.filter(function (x) { return chaveMesa(x.mesa) === chaveMesa(n); })[0];
        if (ex && !minha(ex)) return abrirDaLista(ex);
        S.mesaAtiva = ex ? { id: ex.id, mesa: ex.mesa, linhas: ex.linhas || [] } : { id: '', mesa: n, linhas: [] }; S.cart = []; m.remove(); carrinho();
      };
    });
  }
  function enfileirarPedido() {
    var ma = S.mesaAtiva;
    S.seq++; gravar('pos_seq', S.seq);
    var v = { tipo: 'pedido', chave: chave(), local: S.dev + '-P' + ('0000' + S.seq).slice(-4), ts: new Date().toISOString(), mesa: ma.mesa, mesaId: ma.id || '', itens: S.cart.map(function (i) { return { produtoId: i.produtoId, qtd: i.qtd }; }), estado: 'pendente',
      snap: S.cart.map(function (i) { var p = prod(i.produtoId) || {}; return { nome: p.nome, qtd: i.qtd }; }), operador: S.sess.user.nome };
    S.fila.push(v); guardarFila(); S.cart = []; return v;
  }
  function enviarPedido() {
    if (!S.cart.length) return toast('Adicione produtos ao pedido.', true);
    var nome = S.mesaAtiva.mesa;
    enfileirarPedido(); S.mesaAtiva = null; carrinho(); barra();
    toast('Pedido guardado para a mesa ' + nome + (S.online ? '.' : ' (será enviado quando houver internet).'));
    if (S.online) sincronizar(true);
  }
  function cobrarMesa() {
    if (!S.online || !navigator.onLine) return toast('Sem internet: para cobrar a mesa é preciso ligação. Pode continuar a enviar pedidos.', true);
    if (!(S.caixa && S.caixa.aberta)) return toast('Sem caixa aberta.', true);
    var ma = S.mesaAtiva, btn = $('#cb'); btn.disabled = true;
    if (S.cart.length) enfileirarPedido();
    sincronizar(true).then(function () {
      if (pendentes().length) throw new Error('Há pedidos por enviar. Carregue em Sincronizar e tente outra vez.');
      return chamar('mesas_abertas', {});
    }).then(function (r) {
      var m = r.rows.filter(function (x) { return chaveMesa(x.mesa) === chaveMesa(ma.mesa); })[0];
      if (!m) throw new Error('Mesa não encontrada: pode já ter sido cobrada.');
      return chamar('venda_detalhe', { id: m.id });
    }).then(function (d) {
      btn.disabled = false; S.mesaAtiva = { id: d.venda.id, mesa: d.venda.mesa, linhas: d.itens }; carrinho();
      pagamentoMesa(d);
    }).catch(function (e) { btn.disabled = false; toast(e.message, true); carrinho(); });
  }
  function pagamentoMesa(d) {
    var tot = d.venda.total, formas = (S.boot && S.boot.formas) || { NUMERARIO: 'Numerário', MOBILE_MONEY: 'Mobile Money', CARTAO: 'Cartão' };
    var kc = 'pos_cp_' + d.venda.id; var ck = ler(kc, null); if (!ck) { ck = chave(); gravar(kc, ck); }
    modal('<h3 style="margin-top:0">Cobrar mesa ' + esc(d.venda.mesa) + '</h3>' + d.itens.map(function (i) { return '<div style="font-size:13px">' + i.qtd + '× ' + esc(i.nome) + ' <span class="mut">· ' + esc(i.pedidoPor || '') + '</span></div>'; }).join('') +
      '<div class="total">' + fmt(tot) + ' FCFA</div>' + Object.keys(formas).map(function (f) { return '<div class="f"><label>' + esc(formas[f]) + '</label><input class="pg" data-f="' + f + '" inputmode="numeric" value="' + (f === 'NUMERARIO' ? tot : '') + '"></div>'; }).join('') +
      '<div class="f" id="rfw" style="display:none"><label>Referência Mobile Money</label><input id="rf"></div><div id="pr" class="note"></div><div class="row"><button class="sec" data-todo="MOBILE_MONEY">Tudo Mobile Money</button><button class="sec" data-todo="NUMERARIO">Tudo numerário</button></div><div class="row acts" style="margin-top:10px"><button class="sec" id="cx">Voltar</button><button id="ok">Confirmar</button></div>', function (m) {
      function soma() { return $$('.pg', m).reduce(function (a, i) { return a + (Number(i.value) || 0); }, 0); }
      function res() { var dif = tot - soma(); $('#rfw', m).style.display = (Number($('.pg[data-f="MOBILE_MONEY"]', m).value) || 0) > 0 ? '' : 'none'; $('#pr', m).innerHTML = dif === 0 ? '<span class="ok">Pagamento completo.</span>' : dif > 0 ? 'Falta receber <b>' + fmt(dif) + '</b>' : '<span class="bad-t">Excede em ' + fmt(-dif) + '</span>'; }
      $$('.pg', m).forEach(function (i) { i.oninput = res; });
      $$('[data-todo]', m).forEach(function (b) { b.onclick = function () { $$('.pg', m).forEach(function (i) { i.value = i.getAttribute('data-f') === b.getAttribute('data-todo') ? tot : ''; }); res(); }; });
      res(); $('#cx', m).onclick = function () { m.remove(); };
      $('#ok', m).onclick = function () {
        if (soma() !== tot) return toast('O pagamento tem de ser igual ao total.', true);
        var pags = $$('.pg', m).filter(function (i) { return Number(i.value) > 0; }).map(function (i) { var f = i.getAttribute('data-f'); return { forma: f, valor: Math.round(Number(i.value)), ref: f === 'MOBILE_MONEY' ? $('#rf', m).value.trim() : '' }; });
        var mm = pags.filter(function (p) { return p.forma === 'MOBILE_MONEY'; })[0];
        if (mm && mm.ref.length < 4) return toast('Indique a referência do Mobile Money.', true);
        var b = this; b.disabled = true;
        chamar('mesa_cobrar', { chave: ck, id: d.venda.id, pagamentos: pags }).then(function (r) {
          m.remove(); try { LS.removeItem(kc); } catch (e) { /* ignora */ }
          S.mesaAtiva = null; S.cart = []; carrinho();
          recibo({ num: r.num, ts: new Date().toISOString(), operador: S.sess.user.nome, snap: d.itens.map(function (i) { return { nome: i.nome, qtd: i.qtd, total: i.total }; }), total: r.total, igv: r.igv, pagamentos: pags });
          atualizar(true);
        }).catch(function (e) { b.disabled = false; toast(e.rede ? 'Sem ligação: nada foi cobrado ainda. Tente outra vez (não há risco de cobrar duas vezes).' : e.message, true); });
      };
    });
  }
  function modal(html, montar) {
    var m = document.createElement('div'); m.className = 'modal'; m.innerHTML = '<div class="mbox">' + html + '</div>'; document.body.appendChild(m);
    m.onclick = function (e) { if (e.target === m) m.remove(); };
    if (montar) montar(m); return m;
  }
  function cobrar() {
    if (!S.cart.length) return toast('Adicione produtos.', true);
    if (!(S.caixa && S.caixa.aberta)) return toast('Sem caixa aberta.', true);
    var t = totais(S.cart, 0), formas = (S.boot && S.boot.formas) || { NUMERARIO: 'Numerário', MOBILE_MONEY: 'Mobile Money', CARTAO: 'Cartão' };
    modal('<div class="total">' + fmt(t.total) + ' FCFA</div>' + Object.keys(formas).map(function (f) {
      return '<div class="f"><label>' + esc(formas[f]) + '</label><input class="pg" data-f="' + f + '" inputmode="numeric" value="' + (f === 'NUMERARIO' ? t.total : '') + '"></div>';
    }).join('') + '<div class="f" id="rfw" style="display:none"><label>Referência Mobile Money (código do SMS)</label><input id="rf" autocomplete="off"></div><div class="f"><label>Dinheiro entregue (troco)</label><input id="pe" inputmode="numeric"></div><div id="pr" class="note"></div>' +
      '<div class="row"><button class="sec" data-todo="MOBILE_MONEY">Tudo Mobile Money</button><button class="sec" data-todo="NUMERARIO">Tudo numerário</button></div><div class="row acts" style="margin-top:10px"><button class="sec" id="cx">Voltar</button><button id="ok">Confirmar</button></div>', function (m) {
      function soma() { return $$('.pg', m).reduce(function (s, i) { return s + (Number(i.value) || 0); }, 0); }
      function res() {
        var d = t.total - soma(), cash = Number($('.pg[data-f="NUMERARIO"]', m).value) || 0, ent = Number($('#pe', m).value) || 0;
        $('#rfw', m).style.display = (Number($('.pg[data-f="MOBILE_MONEY"]', m).value) || 0) > 0 ? '' : 'none';
        $('#pr', m).innerHTML = d === 0 ? '<span class="ok">Pagamento completo.</span>' + (ent > 0 && ent >= cash ? ' Troco: <b>' + fmt(ent - cash) + '</b>' : '') : d > 0 ? 'Falta receber <b>' + fmt(d) + '</b>' : '<span class="bad-t">Excede o total em ' + fmt(-d) + '</span>';
      }
      $$('.pg,#pe', m).forEach(function (i) { i.oninput = res; });
      $$('[data-todo]', m).forEach(function (b) { b.onclick = function () { $$('.pg', m).forEach(function (i) { i.value = i.getAttribute('data-f') === b.getAttribute('data-todo') ? t.total : ''; }); res(); }; });
      res();
      $('#cx', m).onclick = function () { m.remove(); };
      $('#ok', m).onclick = function () {
        var pags = $$('.pg', m).filter(function (i) { return Number(i.value) > 0; }).map(function (i) { var f = i.getAttribute('data-f'); return { forma: f, valor: Math.round(Number(i.value)), ref: f === 'MOBILE_MONEY' ? $('#rf', m).value.trim() : '' }; });
        if (soma() !== t.total) return toast('O pagamento tem de ser igual ao total.', true);
        var mm = pags.filter(function (p) { return p.forma === 'MOBILE_MONEY'; })[0];
        if (mm && mm.ref.length < 4) return toast('Indique a referência do Mobile Money.', true);
        if (mm && S.fila.some(function (v) { return (v.pagamentos || []).some(function (p) { return p.ref && p.ref.toLowerCase() === mm.ref.toLowerCase(); }); })) return toast('Essa referência já foi usada neste aparelho.', true);
        S.seq++; gravar('pos_seq', S.seq);
        var v = { chave: chave(), local: S.dev + '-' + ('0000' + S.seq).slice(-4), ts: new Date().toISOString(), itens: S.cart.map(function (i) { return { produtoId: i.produtoId, qtd: i.qtd }; }), pagamentos: pags, total: t.total, igv: t.igv, estado: 'pendente', snap: S.cart.map(function (i) { var p = prod(i.produtoId) || {}; return { nome: p.nome, qtd: i.qtd, preco: p.precoVenda, total: Math.round((p.precoVenda || 0) * i.qtd) }; }), operador: S.sess.user.nome };
        S.fila.push(v); guardarFila(); S.cart = []; m.remove(); recibo(v); carrinho(); barra();
        if (S.online) sincronizar(true);
      };
    });
  }
  function recibo(v) {
    var cf = (S.boot && S.boot.cfg) || {};
    modal('<div id="rc"><h3 style="text-align:center;margin:0">' + esc(cf.EMPRESA || '') + '</h3><p class="mut" style="text-align:center;margin:2px">' + esc(cf.MORADA || '') + (cf.NIF ? ' · NIF ' + esc(cf.NIF) : '') + '</p><p>Venda <b>' + esc(v.num || v.local) + '</b>' + (v.num ? '' : ' <span class="mut">(número provisório; o oficial surge após o envio)</span>') + '<br>' + new Date(v.ts).toLocaleString('pt-PT') + ' · ' + esc(v.operador) + '</p><table>' +
      v.snap.map(function (i) { return '<tr><td>' + esc(i.nome) + ' ×' + i.qtd + '</td><td style="text-align:right">' + fmt(i.total) + '</td></tr>'; }).join('') + '<tr><td><b>Total</b></td><td style="text-align:right"><b>' + fmt(v.total) + '</b></td></tr><tr><td class="mut">IGV incluído</td><td style="text-align:right" class="mut">' + fmt(v.igv) + '</td></tr></table><p class="mut">' +
      v.pagamentos.map(function (p) { return esc(((S.boot && S.boot.formas) || {})[p.forma] || p.forma) + ': ' + fmt(p.valor) + (p.ref ? ' (' + esc(p.ref) + ')' : ''); }).join(' · ') + '</p></div><div class="row acts"><button class="sec" onclick="window.print()">Imprimir</button><button onclick="this.closest(\'.modal\').remove()">Nova venda</button></div>');
  }
  function ecraFila() {
    var hoje = S.fila.slice().reverse();
    modal('<h3 style="margin-top:0">Vendas neste aparelho</h3>' + (hoje.length ? '<table>' + hoje.slice(0, 80).map(function (v) {
      var cor = v.estado === 'enviada' ? 'ok' : v.estado === 'erro' ? 'bad-t' : '';
      return '<tr><td>' + esc(v.num || (v.tipo === 'pedido' ? 'Pedido mesa ' + v.mesa : v.local)) + (v.aviso ? '<div class="bad-t" style="font-size:12px">' + esc(v.aviso) + '</div>' : '') + '<div class="mut">' + new Date(v.ts).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) + '</div></td><td style="text-align:right">' + (v.tipo === 'pedido' ? '—' : fmt(v.total)) + '</td><td class="' + cor + '">' + (v.estado === 'enviada' ? 'enviada' : v.estado === 'erro' ? 'erro' : 'por enviar') + (v.erro ? '<div style="font-size:12px">' + esc(v.erro) + '</div>' : '') + '</td><td>' + (v.estado === 'erro' ? '<button class="sec" data-rt="' + v.chave + '">Tentar</button> ' : '') + '</td></tr>';
    }).join('') + '</table>' : '<p class="mut">Ainda não há vendas.</p>') + '<div class="row acts" style="margin-top:10px"><button class="sec" id="lp">Limpar enviadas</button><button id="fc">Fechar</button></div>', function (m) {
      $('#fc', m).onclick = function () { m.remove(); };
      $('#lp', m).onclick = function () { S.fila = S.fila.filter(function (v) { return v.estado !== 'enviada'; }); guardarFila(); m.remove(); barra(); };
      $$('[data-rt]', m).forEach(function (b) { b.onclick = function () { var v = S.fila.filter(function (x) { return x.chave === b.getAttribute('data-rt'); })[0]; v.estado = 'pendente'; delete v.erro; guardarFila(); m.remove(); sincronizar(false); }; });
    });
  }

  /* ---------- arranque ---------- */
  window.addEventListener('online', function () { S.online = true; barra(); sincronizar(true); });
  window.addEventListener('offline', function () { S.online = false; barra(); });
  window.addEventListener('beforeunload', function (e) { if (pendentes().length) { e.preventDefault(); e.returnValue = ''; } });
  setInterval(function () { if (S.sess && navigator.onLine) { sincronizar(true); } }, 60000);
  setInterval(function () { if (S.sess && navigator.onLine && !pendentes().length) atualizar(true); }, 300000);
  setInterval(function () { if (S.sess && S.online && navigator.onLine) chamar('mesas_abertas', {}).then(function (r) { S.mesas = r.rows; S.mesasResumo = r.resumo; S.mesasHora = Date.now(); gravar('pos_mesas', S.mesas); gravar('pos_mesas_hora', S.mesasHora); faixa(); }).catch(function () { }); else faixa(); }, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
  render();
  if (S.sess && navigator.onLine) { atualizar(true).then(function () { sincronizar(true); }); }
  window.__pos = { S: S, chamar: chamar, sincronizar: sincronizar, totais: totais, render: render }; // para testes
})();
