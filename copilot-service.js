// ============================================================================
//  copilot-service.js
//  Servicio de automatización para Microsoft 365 Copilot
//  ---------------------------------------------------------------------------
//  - Navegador: Microsoft EDGE en modo InPrivate (incógnito) -> SIEMPRE pide login.
//  - Login automático; ÚNICO paso manual: TOKEN / MFA (tú lo ingresas).
//  - Maneja MÚLTIPLES pantallas del flujo (todas verificadas en vivo):
//        1) "Selección de la cuenta" (cuenta recordada) o formulario de correo.
//        2) "Escribir contraseña".
//        3) TOKEN / MFA (único paso manual).
//        4) POST-TOKEN: "Inicie sesión con la cuenta profesional" (sync de perfil
//           de Edge) -> botón "Continuar con el perfil actual".  <-- NUEVO
//        5) "¿Mantener la sesión iniciada?" (KMSI).
//        6) "Acceso supervisado" (Defender for Cloud Apps) ->
//           checkbox "Ocultar notificación una semana" + "Continuar en current browser".
//  - Captura de respuesta ROBUSTA (corrige el cuelgue en "Copilot está pensando"):
//        * [data-testid="loading-message"] NO desaparece al terminar; CONTIENE el
//          texto de la respuesta y queda visible. NO se puede esperar a que se vaya.
//        * El fin se detecta por ESTABILIZACIÓN del texto de
//          [data-testid="lastChatMessage"] + textbox editable de nuevo.
//
//  INSTALACIÓN:
//     npm init -y
//     npm install playwright
//     npx playwright install msedge
//
//  EJECUCIÓN:
//     node copilot-service.js
//
//  (Opcional) Variables de entorno:
//     COPILOT_EMAIL, COPILOT_PASSWORD, COPILOT_MODEL
// ============================================================================

const { chromium } = require('playwright');
const readline = require('readline');

// ----------------------------------------------------------------------------
//  CONFIGURACIÓN
// ----------------------------------------------------------------------------
const CONFIG = {
  url: 'https://copilot.cloud.microsoft/chat',
  email: process.env.COPILOT_EMAIL || 'CAMBIA_ESTE_CORREO@dominio.com',
  password: process.env.COPILOT_PASSWORD || 'CAMBIA_ESTA_PASSWORD',
  model: process.env.COPILOT_MODEL || 'GPT 5.6 Think deeper',
  browserChannel: 'msedge',
  headless: false,
  loginMaxRetries: 3,
  responseTimeoutMs: 180000,   // espera máx. total por una respuesta
  stableReads: 4,              // lecturas iguales para dar por terminada la respuesta
  stableIntervalMs: 700,       // intervalo entre lecturas de estabilización
};

// ----------------------------------------------------------------------------
//  UTILIDADES DE CONSOLA
// ----------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));
const log = (...a) => console.log('▶', ...a);
const warn = (...a) => console.log('⚠', ...a);
const ok = (...a) => console.log('✔', ...a);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ============================================================================
//  FLUJO DE LOGIN
// ============================================================================
async function doLogin(page) {
  log('Navegando a Copilot...');
  await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded' });

  // "Acceso supervisado" puede aparecer ANTES del login.
  await handleSupervisedAccess(page);

  // La cuenta puede estar recordada -> pantalla "Selección de la cuenta".
  await handleAccountPicker(page);

  // Si no hubo cuenta recordada, aparece el formulario de correo.
  await handleEmailStep(page);

  // Contraseña.
  await handlePasswordStep(page);

  // TOKEN / MFA -> ÚNICO PASO MANUAL.
  await handleTokenStep(page);

  // POST-TOKEN: "Inicie sesión con la cuenta profesional" (sync perfil Edge).
  await handleEdgeProfileSync(page);

  // "¿Mantener la sesión iniciada?" (KMSI).
  await handleStaySignedIn(page);

  // "Acceso supervisado" también aparece DESPUÉS del login (caso confirmado).
  await handleSupervisedAccess(page);

  // Confirmar llegada a Copilot (el dominio puede venir con sufijo .mcas.ms).
  await page.waitForURL(/m365\.cloud\.microsoft|copilot\.cloud\.microsoft/i, { timeout: 60000 });
  await page.getByRole('textbox', { name: /enviar un mensaje a copilot|message copilot/i })
    .first().waitFor({ state: 'visible', timeout: 60000 });

  ok('Login completado. Copilot está listo.');
}

async function clickBtn(page, nameRe) {
  const btn = page.getByRole('button', { name: nameRe }).or(page.locator('#idSIButton9'));
  await btn.first().click();
}

// ----------------------------------------------------------------------------
//  Pantalla "Selección de la cuenta" (cuenta recordada).
//  Verificada en vivo: heading "Selección de la cuenta" + botón con el correo.
//  Si aparece, se hace clic en la cuenta configurada; si no está, "Usar otra cuenta".
// ----------------------------------------------------------------------------
async function handleAccountPicker(page) {
  const picker = page.getByRole('heading', { name: /selecci[oó]n de la cuenta|pick an account/i });
  if (!(await picker.first().isVisible({ timeout: 6000 }).catch(() => false))) return;

  const acct = page.getByRole('button', { name: new RegExp(escapeRe(CONFIG.email), 'i') });
  if (await acct.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await acct.first().click();
    log(`Selección de cuenta: se eligió ${CONFIG.email}.`);
    return;
  }

  const other = page.getByRole('button', { name: /usar otra cuenta|use another account/i });
  if (await other.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await other.first().click();
    log('Selección de cuenta: se eligió "Usar otra cuenta".');
  }
}

// ----------------------------------------------------------------------------
//  Formulario de correo (solo si no hubo cuenta recordada).
// ----------------------------------------------------------------------------
async function handleEmailStep(page) {
  const emailBox = page.getByRole('textbox', { name: /correo|email|someone@example|usuario/i })
    .or(page.locator('input[type="email"]'))
    .or(page.locator('input[name="loginfmt"]'));

  if (!(await emailBox.first().isVisible({ timeout: 6000 }).catch(() => false))) return;

  // Si el campo ya trae el correo (readonly en pantalla de contraseña), no re-escribir.
  const val = await emailBox.first().inputValue().catch(() => '');
  if (val && val.includes('@')) return;

  log('Formulario de correo detectado. Ingresando correo...');
  await emailBox.first().fill(CONFIG.email);
  await clickBtn(page, /^siguiente$|^next$/i);
}

// ----------------------------------------------------------------------------
//  Pantalla "Escribir contraseña".
//  Verificada en vivo: heading "Escribir contraseña" + textbox de contraseña
//  + enlace "Use una aplicación en su lugar".
// ----------------------------------------------------------------------------
async function handlePasswordStep(page) {
  const usePassword = page.getByRole('button', { name: /use su contraseña|usar (mi|su) contraseña|use.*password/i })
    .or(page.getByRole('link', { name: /use su contraseña|use.*password/i }));
  if (await usePassword.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await usePassword.first().click();
    log('Se seleccionó "Usar su contraseña".');
  }

  const passBox = page.getByRole('textbox', { name: /escriba la contraseña|contraseña|password/i })
    .or(page.locator('input[type="password"]'))
    .or(page.locator('input[name="passwd"]'));
  await passBox.first().waitFor({ state: 'visible', timeout: 30000 });
  await passBox.first().fill(CONFIG.password);
  await clickBtn(page, /iniciar sesión|sign in|^siguiente$|^next$/i);
}

// ----------------------------------------------------------------------------
//  Paso del TOKEN / OTP / MFA (único paso manual).
// ----------------------------------------------------------------------------
async function handleTokenStep(page) {
  const otpInput = page.getByRole('textbox', { name: /código|code|verification|otp/i })
    .or(page.locator('input[name="otc"]'))
    .or(page.locator('input[autocomplete="one-time-code"]'));

  const authenticatorText = page.getByText(
    /aprueba la solicitud|approve.*request|abre.*authenticator|open.*authenticator|escribe el n[uú]mero/i
  );

  const kind = await Promise.race([
    otpInput.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => 'otp').catch(() => null),
    authenticatorText.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => 'app').catch(() => null),
  ]);

  if (!kind) {
    warn('No se detectó pantalla de token/MFA (puede que no se requiera).');
    return;
  }

  console.log('\n============================================================');
  console.log('  PASO MANUAL: TOKEN / MFA REQUERIDO');
  console.log('============================================================');

  if (kind === 'app') {
    console.log('  Aprueba la solicitud en tu app Authenticator (o ingresa el número mostrado).');
    await ask('  Cuando lo hayas aprobado, pulsa ENTER para continuar... ');
  } else {
    const token = await ask('  Ingresa el TOKEN/código de verificación: ');
    await otpInput.first().fill(token);
    await clickBtn(page, /verificar|comprobar|verify|siguiente|next/i);
  }
  ok('Token procesado.');
}

// ----------------------------------------------------------------------------
//  POST-TOKEN: "Inicie sesión con la cuenta profesional" (sincronización de
//  perfil de Microsoft Edge). Texto exacto (verificado por el usuario):
//    "Para obtener la mejor experiencia de exploración al acceder a un servicio,
//     una aplicación o un sitio web, le recomendamos que inicies sesión en su
//     perfil del explorador Microsoft Edge con <correo>. Cuando se usa el perfil
//     de trabajo del explorador, la organización puede ver algunos de sus datos."
//  ACCIÓN REQUERIDA: pulsar "Continuar con el perfil actual".
//  (No queremos sincronizar el perfil corporativo de Edge: usamos el actual.)
// ----------------------------------------------------------------------------
async function handleEdgeProfileSync(page) {
  // El botón puede aparecer con distintas variantes de texto según idioma/versión.
  const continueCurrent = page.getByRole('button', {
    name: /continuar con el perfil actual|continue without.*profile|seguir con el perfil actual|current profile/i,
  }).or(page.getByRole('link', {
    name: /continuar con el perfil actual|seguir con el perfil actual/i,
  }));

  // Esperar por el heading característico para no confundir con otras pantallas.
  const heading = page.getByText(/inicie sesión con la cuenta profesional|sign in with your work account/i);

  const appeared = await Promise.race([
    continueCurrent.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false),
    heading.first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false),
  ]);

  if (!appeared) return; // No apareció: seguimos.

  if (await continueCurrent.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await continueCurrent.first().click();
    log('Sync de perfil Edge: se pulsó "Continuar con el perfil actual".');
    // Dar un momento a la navegación posterior.
    await page.waitForTimeout(1500);
  } else {
    warn('Pantalla de sync de perfil detectada, pero no se encontró el botón "Continuar con el perfil actual".');
  }
}

async function handleStaySignedIn(page) {
  const kmsiText = page.getByText(/mantener la sesión iniciada|stay signed in|reducir.*inicios de sesión/i);
  if (await kmsiText.first().isVisible({ timeout: 6000 }).catch(() => false)) {
    await clickBtn(page, /^sí$|^yes$/i);
    log('KMSI: se mantuvo la sesión iniciada.');
  }
}

// ----------------------------------------------------------------------------
//  Pantalla "Acceso supervisado" (Microsoft Defender for Cloud Apps).
//  Verificada en vivo:
//    heading: "Usar el explorador Edge para obtener un mejor rendimiento..."
//    checkbox: "Ocultar esta notificación en todas las aplicaciones durante una semana"
//    button:  "Continuar en current browser"
// ----------------------------------------------------------------------------
async function handleSupervisedAccess(page) {
  const continueBtn = page.getByRole('button', {
    name: /continuar en current browser|continuar en el explorador|continue.*browser/i,
  });

  if (await continueBtn.first().isVisible({ timeout: 8000 }).catch(() => false)) {
    const hideCheck = page.getByRole('checkbox', {
      name: /ocultar esta notificaci[oó]n|hide this notification/i,
    });
    if (await hideCheck.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await hideCheck.first().check().catch(() => {});
      log('Acceso supervisado: se marcó "Ocultar notificación por una semana".');
    }

    await continueBtn.first().click();
    log('Acceso supervisado: se continuó en el navegador actual.');
    await page.waitForURL(/m365\.cloud\.microsoft|copilot\.cloud\.microsoft/i, { timeout: 30000 })
      .catch(() => page.waitForTimeout(2000));
  }
}

// ============================================================================
//  SELECCIÓN DE MODELO
// ============================================================================
async function selectModel(page, modelName) {
  try {
    const selector = page.getByRole('button', { name: /selector de modelos|model picker|pick a model/i });
    await selector.first().click();

    const directItem = page.getByRole('menuitemradio', { name: new RegExp(escapeRe(modelName), 'i') });
    if (await directItem.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await directItem.first().click();
      ok(`Modelo seleccionado: ${modelName}`);
      return;
    }

    const gptEntry = page.getByRole('menuitem', { name: /^gpt/i })
      .or(page.locator('[data-test-id="gptSubMenuModelTrigger-OpenAI"]'));
    await gptEntry.first().click();

    const variant = page.getByRole('menuitemradio', { name: new RegExp(escapeRe(modelName), 'i') });
    await variant.first().waitFor({ state: 'visible', timeout: 6000 });
    await variant.first().click();
    ok(`Modelo seleccionado: ${modelName}`);
  } catch (e) {
    warn(`No se pudo seleccionar "${modelName}". Se continúa con el modelo por defecto. (${e.message})`);
    await page.keyboard.press('Escape').catch(() => {});
  }
}

// ============================================================================
//  ENVIAR MENSAJE Y CAPTURAR RESPUESTA
//  ---------------------------------------------------------------------------
//  CORRECCIÓN CLAVE (verificada en vivo):
//   - NO esperar a que desaparezca [data-testid="loading-message"]: ese elemento
//     permanece visible y CONTIENE el texto final -> causaba el cuelgue infinito.
//   - Estrategia correcta: esperar a que aparezca una nueva respuesta y luego
//     esperar a que su TEXTO se ESTABILICE (deje de crecer) durante N lecturas.
// ============================================================================
async function sendMessageAndGetReply(page, message) {
  const input = page.getByRole('textbox', { name: /enviar un mensaje a copilot|message copilot/i });
  await input.first().click();
  await input.first().fill(message);

  const before = await page.locator('[data-testid="copilot-message-div"]').count();
  await input.first().press('Enter');

  // 1) Esperar a que aparezca una NUEVA respuesta de Copilot.
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="copilot-message-div"]').length > n,
    before,
    { timeout: CONFIG.responseTimeoutMs }
  );

  // 2) Esperar ESTABILIZACIÓN del texto de la última respuesta.
  const lastReply = page.locator('[data-testid="lastChatMessage"]').last()
    .or(page.locator('[data-testid="copilot-message-reply-div"]').last());

  let last = '';
  let stable = 0;
  const start = Date.now();

  while (Date.now() - start < CONFIG.responseTimeoutMs) {
    const current = (await lastReply.first().innerText().catch(() => '')) || '';

    const editable = await page.evaluate(() => {
      const tb = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
      return tb ? tb.getAttribute('aria-disabled') !== 'true' : true;
    }).catch(() => true);

    if (current && current === last) {
      stable++;
      if (stable >= CONFIG.stableReads && editable) break;
    } else {
      stable = 0;
    }

    last = current;
    await page.waitForTimeout(CONFIG.stableIntervalMs);
  }

  return last.replace(/^\s*copilot (said|dijo):?\s*/i, '').trim();
}

// ============================================================================
//  BUCLE DEL SERVICIO
// ============================================================================
async function serviceLoop(page) {
  console.log('\n============================================================');
  console.log('  SERVICIO COPILOT ACTIVO');
  console.log('     Escribe tu mensaje y pulsa ENTER.');
  console.log('     /new  -> iniciar un chat nuevo');
  console.log('     /exit -> cerrar el servicio');
  console.log('============================================================\n');

  while (true) {
    const msg = await ask('Tú > ');
    if (!msg) continue;
    if (msg === '/exit') break;

    if (msg === '/new') {
      const nuevo = page.getByRole('link', { name: /nuevo chat|new chat/i });
      await nuevo.first().click().catch(() => {});
      await selectModel(page, CONFIG.model);
      ok('Nuevo chat iniciado.');
      continue;
    }

    try {
      process.stdout.write('Copilot está pensando...\n');
      const reply = await sendMessageAndGetReply(page, msg);
      console.log('\nCopilot >\n' + reply + '\n');
    } catch (e) {
      warn('Error al obtener respuesta: ' + e.message);
    }
  }
}

// ============================================================================
//  MAIN
// ============================================================================
(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      channel: CONFIG.browserChannel,
      headless: CONFIG.headless,
      args: ['--inprivate', '--guest', '--no-first-run', '--no-default-browser-check'],
    });
  } catch (e) {
    console.error('No se pudo iniciar Microsoft Edge.');
    console.error('   Ejecuta: npx playwright install msedge');
    console.error('   Detalle:', e.message);
    rl.close();
    process.exit(1);
  }

  const context = await browser.newContext({ storageState: undefined, ignoreHTTPSErrors: true });
  await context.clearCookies().catch(() => {});
  const page = await context.newPage();

  let logged = false;
  for (let attempt = 1; attempt <= CONFIG.loginMaxRetries && !logged; attempt++) {
    try {
      log(`Intento de login ${attempt}/${CONFIG.loginMaxRetries}`);
      await doLogin(page);
      logged = true;
    } catch (e) {
      warn(`Falló el intento ${attempt}: ${e.message}`);
      if (attempt < CONFIG.loginMaxRetries) {
        await context.clearCookies().catch(() => {});
        await page.waitForTimeout(1500);
      }
    }
  }

  if (!logged) {
    console.error('No fue posible completar el login tras varios intentos.');
    await browser.close();
    rl.close();
    process.exit(1);
  }

  await selectModel(page, CONFIG.model);
  await serviceLoop(page);

  ok('Cerrando servicio...');
  await browser.close();
  rl.close();
  process.exit(0);
})();
