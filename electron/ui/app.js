const $ = (sel) => document.querySelector(sel);
const api = window.agente;

const FUNCOES = [
  { id: 'etiqueta', label: 'Etiqueta' },
  { id: 'cupom', label: 'Cupom' },
];

let estado = null;
let timerBalanca = null;

// --- Utilidades --------------------------------------------------------------

function toast(msg, erro = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = erro ? 'toast erro' : 'toast';
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 3500);
}

function mensagemErro(err) {
  // Erros do ipcMain chegam como "Error invoking remote method 'x': Error: msg".
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function el(tag, props = {}, filhos = []) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const f of [].concat(filhos)) n.append(f);
  return n;
}

// PDF, Fax, OneNote, XPS… — filas do Windows que não imprimem etiqueta/cupom.
function ehVirtual(p) {
  return (
    /pdf|fax|onenote|xps|send to|enviar para/i.test(p.nome) ||
    /^(nul:|portprompt:|shrfax:|pdfcmon|cpw\d*:|xpsport:|file:)$/i.test(p.porta || '')
  );
}

function origem(p) {
  if (p.compartilhadaDeOutroPc) return 'Compartilhada';
  if ((p.porta || '').toUpperCase().startsWith('USB')) return 'USB';
  if (/^(IP_)?\d{1,3}(\.\d{1,3}){3}/.test(p.porta || '')) return 'Rede';
  return 'Outra';
}

// --- Bloqueio ------------------------------------------------------------------

async function bloquear() {
  clearInterval(timerBalanca);
  estado = null;
  $('#tela-app').hidden = true;
  $('#tela-bloqueio').hidden = false;
  $('#senha').value = '';
  esconderSenha('senha');
  $('#erro-senha').hidden = true;
  // Sem senha definida (instalação silenciosa) não há como entrar: só reinstalando.
  const { senhaDefinida } = await api.statusSenha();
  $('#campos-senha').hidden = !senhaDefinida;
  $('#sem-senha').hidden = senhaDefinida;
  if (senhaDefinida) $('#senha').focus();
}

function esconderSenha(id) {
  $(`#${id}`).type = 'password';
  $(`[data-mostrar="${id}"]`).checked = false;
}

// "Mostrar senha": alterna o campo indicado em data-mostrar entre texto e senha.
document.querySelectorAll('[data-mostrar]').forEach((check) => {
  check.addEventListener('change', () => {
    $(`#${check.dataset.mostrar}`).type = check.checked ? 'text' : 'password';
  });
});

bloquear();

$('#form-senha').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await api.entrar($('#senha').value);
  if (!ok) {
    $('#erro-senha').hidden = false;
    $('#senha').select();
    return;
  }
  $('#tela-bloqueio').hidden = true;
  $('#tela-app').hidden = false;
  await carregar();
  timerBalanca = setInterval(atualizarBalanca, 1000);
});

$('#bloquear').addEventListener('click', async () => {
  await api.bloquear();
  bloquear();
});

api.aoBloquear(bloquear);

// --- Abas ------------------------------------------------------------------------

document.querySelectorAll('.aba').forEach((botao) => {
  botao.addEventListener('click', () => {
    document.querySelectorAll('.aba').forEach((b) => b.classList.toggle('ativa', b === botao));
    document.querySelectorAll('.painel').forEach((p) => (p.hidden = p.dataset.painel !== botao.dataset.aba));
  });
});

// --- Carregar estado ----------------------------------------------------------

async function carregar() {
  try {
    estado = await api.obterEstado();
  } catch (err) {
    toast(mensagemErro(err), true);
    return;
  }

  const { servidor, config } = estado;
  const status = $('#status-servidor');
  status.textContent = servidor.ok ? `Ativo · porta ${config.porta}` : 'Parado';
  status.className = servidor.ok ? 'pilula ok' : 'pilula erro';
  $('#aviso-servidor').hidden = servidor.ok;
  $('#aviso-servidor').textContent = servidor.erro || '';

  renderImpressoras();
  renderBalanca();
  renderAgente();
}

$('#recarregar').addEventListener('click', carregar);
$('#mostrar-virtuais').addEventListener('change', renderImpressoras);

// --- Impressoras ----------------------------------------------------------------

function renderImpressoras() {
  const lista = $('#lista-impressoras');
  lista.replaceChildren();
  const { impressoras, config } = estado;
  const mostrarVirtuais = $('#mostrar-virtuais').checked;

  const nomes = new Set(impressoras.map((p) => p.nome));
  for (const f of FUNCOES) {
    const nome = config.impressoras[f.id];
    if (nome && !nomes.has(nome)) {
      lista.append(
        el('li', {}, [
          el('div', {}, [
            el('div', { className: 'nome', textContent: nome }),
            el('div', { className: 'meta' }, [
              el('span', { className: 'pilula erro', textContent: `Configurada para ${f.label}, mas não existe no Windows` }),
            ]),
          ]),
          el('div', { className: 'controles' }, [switchFuncao(f, nome)]),
        ])
      );
    }
  }

  const visiveis = impressoras.filter(
    (p) => mostrarVirtuais || !ehVirtual(p) || FUNCOES.some((f) => config.impressoras[f.id] === p.nome)
  );

  if (visiveis.length === 0 && lista.childElementCount === 0) {
    lista.append(
      el('li', {}, [
        el('span', {
          className: 'vazio',
          textContent: 'Nenhuma impressora instalada no Windows. Instale a impressora (ou adicione a compartilhada de outro PC) e clique em Atualizar.',
        }),
      ])
    );
    return;
  }

  for (const p of visiveis) {
    const funcaoDela = FUNCOES.find((f) => config.impressoras[f.id] === p.nome);
    const testar = el('button', { className: 'botao pequeno', textContent: 'Testar' });
    testar.addEventListener('click', () => testarImpressora(p.nome, funcaoDela?.id ?? 'etiqueta', testar));

    const meta = [el('span', { className: 'pilula', textContent: origem(p) })];
    if (p.porta) meta.push(el('span', { textContent: p.porta }));
    if (!p.pronta) meta.push(el('span', { className: 'pilula aviso', textContent: 'Offline' }));

    lista.append(
      el('li', {}, [
        el('div', {}, [
          el('div', { className: 'nome', textContent: p.nome, title: p.nome }),
          el('div', { className: 'meta' }, meta),
        ]),
        el('div', { className: 'controles' }, [...FUNCOES.map((f) => switchFuncao(f, p.nome)), testar]),
      ])
    );
  }
}

function switchFuncao(funcao, nome) {
  const input = el('input', { type: 'checkbox', checked: estado.config.impressoras[funcao.id] === nome });
  input.addEventListener('change', async () => {
    // Cada função fica em uma impressora só: ligar aqui tira das outras.
    const impressoras = { ...estado.config.impressoras, [funcao.id]: input.checked ? nome : null };
    document.querySelectorAll('#lista-impressoras input').forEach((i) => (i.disabled = true));
    try {
      const config = await api.salvarImpressoras(impressoras);
      estado.config = config;
      toast(input.checked ? `${funcao.label}: ${nome}` : `${funcao.label}: nenhuma impressora`);
    } catch (err) {
      toast(mensagemErro(err), true);
    }
    renderImpressoras();
  });
  return el('label', { className: 'switch' }, [input, funcao.label]);
}

async function testarImpressora(nome, funcao, botao) {
  botao.disabled = true;
  botao.textContent = 'Imprimindo…';
  try {
    await api.testarImpressora({
      nome,
      funcao,
      larguraMm: Number($('#teste-largura').value) || 100,
      alturaMm: Number($('#teste-altura').value) || 50,
    });
    toast(`Teste enviado para ${nome}`);
  } catch (err) {
    toast(`Falha ao imprimir em ${nome}: ${mensagemErro(err)}`, true);
  } finally {
    botao.disabled = false;
    botao.textContent = 'Testar';
  }
}

// --- Balança --------------------------------------------------------------------

function renderBalanca() {
  const { config, portasSeriais, baudRates } = estado;
  const sel = $('#balanca-porta-sel');
  sel.replaceChildren(el('option', { value: 'auto', textContent: 'Automático (procura a balança)' }));
  const caminhos = new Set(portasSeriais.map((p) => p.path));
  if (config.balanca.porta !== 'auto' && !caminhos.has(config.balanca.porta)) {
    sel.append(el('option', { value: config.balanca.porta, textContent: `${config.balanca.porta} (não encontrada)` }));
  }
  for (const p of portasSeriais) {
    sel.append(el('option', { value: p.path, textContent: p.descricao ? `${p.path} — ${p.descricao}` : p.path }));
  }
  sel.value = config.balanca.porta;

  $('#balanca-baud').replaceChildren(...baudRates.map((b) => el('option', { value: b, textContent: b })));
  $('#balanca-baud').value = config.balanca.baudRate;

  mostrarBalanca(estado.balanca);
}

function mostrarBalanca(b) {
  const status = $('#balanca-status');
  if (b.modoSimulado) {
    status.textContent = 'Simulada';
    status.className = 'pilula aviso';
  } else if (b.conectado) {
    status.textContent = 'Conectada';
    status.className = 'pilula ok';
  } else {
    status.textContent = 'Procurando balança…';
    status.className = 'pilula erro';
  }
  const leitura = b.ultimaLeitura;
  $('#balanca-peso').textContent =
    leitura && Number.isFinite(leitura.peso) ? `${leitura.peso.toFixed(3)} ${leitura.unidade || 'kg'}` : '—';
  $('#balanca-porta').textContent = b.porta ? `Porta ${b.porta}` : 'Nenhuma porta respondeu ainda';
}

async function atualizarBalanca() {
  if (!estado) return;
  try {
    mostrarBalanca(await api.estadoBalanca());
  } catch {
    /* sessão bloqueada no meio do intervalo */
  }
}

$('#salvar-balanca').addEventListener('click', async () => {
  try {
    await api.salvarBalanca({
      porta: $('#balanca-porta-sel').value,
      baudRate: Number($('#balanca-baud').value),
    });
  } catch (err) {
    toast(mensagemErro(err), true);
  }
});

// --- Agente ---------------------------------------------------------------------

function renderAgente() {
  const { config, versao, configFile } = estado;
  $('#agente-url').textContent = `http://127.0.0.1:${config.porta}`;
  $('#agente-porta').value = config.porta;
  $('#agente-iniciar').checked = config.iniciarComWindows;
  $('#info-versao').textContent = versao;
  $('#info-arquivo').textContent = configFile;
}

$('#salvar-agente').addEventListener('click', async () => {
  const porta = Number($('#agente-porta').value);
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) {
    toast('Porta inválida: use um número entre 1024 e 65535.', true);
    return;
  }
  try {
    estado.config = await api.salvarAgente({ porta, iniciarComWindows: $('#agente-iniciar').checked });
    renderAgente();
    toast('Configuração do agente salva');
  } catch (err) {
    toast(mensagemErro(err), true);
  }
});

// --- Sair ---------------------------------------------------------------------

function pedirSenhaSair() {
  $('#senha-sair').value = '';
  esconderSenha('senha-sair');
  $('#erro-sair').hidden = true;
  $('#dialogo-sair').showModal();
  $('#senha-sair').focus();
}

$('#sair').addEventListener('click', pedirSenhaSair);
api.aoPedirSenhaSair(pedirSenhaSair);
$('#cancelar-sair').addEventListener('click', () => $('#dialogo-sair').close());
$('#form-sair').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await api.sair($('#senha-sair').value);
  if (!ok) {
    $('#erro-sair').hidden = false;
    $('#senha-sair').select();
  }
});
