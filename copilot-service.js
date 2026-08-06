// ============================================================================
//  copilot-service.js
//  Servicio de automatización para Microsoft 365 Copilot
//  ---------------------------------------------------------------------------
//  - Navegador: Microsoft EDGE en modo InPrivate (incógnito) -> SIEMPRE pide login.
//  - Login automático; ÚNICO paso manual: TOKEN / MFA (tú lo ingresas).
//  - Maneja la pantalla "Acceso supervisado / Continuar en current browser".
//  - Captura la respuesta EN DIRECTO usando data-testid REALES del DOM:
//        copilot-message-div        -> contar respuestas de Copilot
//        copilot-message-reply-div  -> cuerpo de la respuesta
//        lastChatMessage            -> última respuesta
//        loading-message            -> presente mientras hace streaming
//  - Localizadores robustos + reintentos completos del flujo de login.
//
//  INSTALACIÓN:
//     npm init -y
//     npm install playwright
//     npx playwright install msedge
//
//  EJECUCIÓN:
//     node copilot-service.js
//
//  (Opcional) Variables de entorno para no dejar credenciales en el archivo:
//     COPILOT_EMAIL, COPILOT_PASSWORD, COPILOT_MODEL
// ============================================================================

const { chromium } = require('playwright');
const readline = require('readline');

// ----------------------------------------------------------------------------
//  CONFIGURACIÓN
// ----------------------------------------------------------------------------
const CONFIG = {
  url: 'https://copilot.cloud.microsoft/chat',
  email: process.env.COPILOT_EMAIL || 'aabernal@bancolombia.com.co',
  password: process.env.COPILOT_PASSWORD || '4517.Tester.4517',
  model: process.env.COPILOT_MODEL || 'GPT 5.6 Think deeper',
  browserChannel: 'msedge',   // navegador Microsoft Edge
  headless: false,            // false => ves el navegador (necesario para el token)
  loginMaxRetries: 3,         // reintentos completos del flujo de login
  responseTimeoutMs: 120000,  // espera máx. por una respuesta de Copilot
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

  // Puede aparecer "Acceso supervisado" ANTES del login.
  await handleSupervisedAccess(page);

  // En InPrivate SIEMPRE aparece el formulario de login.
  const emailBox = page.getByRole('textbox', { name: /correo|email|someone@example|usuario/i })
    .or(page.locator('input[type="email"]'))
    .or(page.locator('input[name="loginfmt"]'));

  try {
    await emailBox.first().waitFor({ state: 'visible', timeout: 45000 });
  } catch {
    // Por si hubo otra pantalla de acceso supervisado en medio.
    await handleSupervisedAccess(page);
    await emailBox.first().waitFor({ state: 'visible', timeout: 30000 });
  }

  log('Formulario de login detectado. Ingresando credenciales...');
  await emailBox.first().fill(CONFIG.email);
  await clickBtn(page, /^siguiente$|^next$/i);

  // "Usar su contraseña en su lugar" (no siempre aparece).
  const usePassword = page.getByRole('button', { name: /use su contraseña|usar (mi|su) contraseña|use.*password/i })
    .or(page.getByRole('link', { name: /use su contraseña|use.*password/i }));
  if (await usePassword.first().isVisible({ timeout: 6000 }).catch(() => false)) {
    await usePassword.first().click();
    log('Se seleccionó "Usar su contraseña".');
  }

  // Contraseña.
  const passBox = page.getByRole('textbox', { name: /contraseña|password/i })
    .or(page.locator('input[type="password"]'))
    .or(page.locator('input[name="passwd"]'));
  await passBox.first().waitFor({ state: 'visible', timeout: 30000 });
  await passBox.first().fill(CONFIG.password);
  await clickBtn(page, /iniciar sesión|sign in|^siguiente$|^next$/i);

  // TOKEN / MFA -> ÚNICO PASO MANUAL.
  await handleTokenStep(page);

  // "¿Mantener la sesión iniciada?" (KMSI).
  await handleStaySignedIn(page);

  // "Acceso supervisado" también puede salir DESPUÉS del login.
  await handleSupervisedAccess(page);

  // Confirmar llegada a Copilot.
  await page.waitForURL(/m365\.cloud\.microsoft|copilot\.cloud\.microsoft/i, { timeout: 60000 });
  await page.getByRole('textbox', { name: /enviar un mensaje a copilot|message copilot/i })
    .first().waitFor({ state: 'visible', timeout: 60000 });

  ok('Login completado. Copilot está listo.');
}

// Botón genérico tolerante a idioma (con fallback al id clásico de Azure AD).
async function clickBtn(page, nameRe) {
  const btn = page.getByRole('button', { name: nameRe }).or(page.locator('#idSIButton9'));
  await btn.first().click();
}

// Pantalla "Acceso supervisado / Continuar en current browser" (Defender for Cloud Apps).
async function handleSupervisedAccess(page) {
  const continueBtn = page.getByRole('button', {
    name: /continuar en current browser|continuar en el explorador|continue.*browser/i,
  });
  if (await continueBtn.first().isVisible({ timeout: 6000 }).catch(() => false)) {
    await continueBtn.first().click();
    log('Acceso supervisado: se continuó en el navegador actual.');
    await page.waitForTimeout(1500);
  }
}

// Paso del TOKEN / OTP / MFA (único paso manual).
async function handleTokenStep(page) {
  const otpInput = page.getByRole('textbox', { name: /código|code|verification|otp/i })
    .or(page.locator('input[name="otc"]'))
    .or(page.locator('input[autocomplete="one-time-code"]'));

  const authenticatorText = page.getByText(
    /aprueba la solicitud|approve.*request|abre.*authenticator|open.*authenticator|escribe el n[uú]mero/i
  );

  const kind = await Promise.race([
    otpInput.first().waitFor({ state: 'visible', timeout: 8000 }).then(() => 'otp').catch(() => null),
    authenticatorText.first().waitFor({ state: 'visible', timeout: 8000 }).then(() => 'app').catch(() => null),
  ]);

  if (!kind) {
    warn('No se detectó pantalla de token/MFA (puede que no se requiera).');
    return;
  }

  console.log('\n============================================================');
  console.log('  🔐  PASO MANUAL: TOKEN / MFA REQUERIDO');
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

// "¿Mantener la sesión iniciada?"
async function handleStaySignedIn(page) {
  const kmsiText = page.getByText(/mantener la sesión iniciada|stay signed in|reducir.*inicios de sesión/i);
  if (await kmsiText.first().isVisible({ timeout: 6000 }).catch(() => false)) {
    await clickBtn(page, /^sí$|^yes$/i);
    log('KMSI: se mantuvo la sesión iniciada.');
  }
}

// ============================================================================
//  SELECCIÓN DE MODELO  (Selector de modelos -> submenú GPT -> variante)
// ============================================================================
async function selectModel(page, modelName) {
  try {
    const selector = page.getByRole('button', { name: /selector de modelos|model picker|pick a model/i });
    await selector.first().click();

    // ¿El modelo está directo en el menú principal?
    const directItem = page.getByRole('menuitemradio', { name: new RegExp(escapeRe(modelName), 'i') });
    if (await directItem.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await directItem.first().click();
      ok(`Modelo seleccionado: ${modelName}`);
      return;
    }

    // Si no, abrimos el submenú "GPT (OpenAI)".
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
//  ENVIAR MENSAJE Y CAPTURAR RESPUESTA  (localizadores data-testid reales)
// ============================================================================
async function sendMessageAndGetReply(page, message) {
  const input = page.getByRole('textbox', { name: /enviar un mensaje a copilot|message copilot/i });
  await input.first().click();
  await input.first().fill(message);

  // Contamos las respuestas de Copilot ANTES de enviar.
  const before = await page.locator('[data-testid="copilot-message-div"]').count();

  await input.first().press('Enter');

  // 1) Esperar a que aparezca una NUEVA respuesta de Copilot.
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="copilot-message-div"]').length > n,
    before,
    { timeout: CONFIG.responseTimeoutMs }
  );

  // 2) Esperar a que TERMINE el streaming: el "loading-message" desaparece.
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="loading-message"]'),
    undefined,
    { timeout: CONFIG.responseTimeoutMs }
  ).catch(() => { /* si el loader nunca aparece, continuamos */ });

  // 3) Estabilización final del texto de la ÚLTIMA respuesta.
  const lastReply = page.locator('[data-testid="lastChatMessage"]').last()
    .or(page.locator('[data-testid="copilot-message-reply-div"]').last());

  let last = '';
  let stable = 0;
  const start = Date.now();
  while (Date.now() - start < CONFIG.responseTimeoutMs) {
    const current = (await lastReply.first().innerText().catch(() => '')) || '';
    if (current && current === last) {
      if (++stable >= 3) break; // 3 lecturas iguales => streaming terminado
    } else {
      stable = 0;
    }
    last = current;
    await page.waitForTimeout(500);
  }

  // Limpiar el encabezado "Copilot said:" que trae el reply-div.
  return last.replace(/^\s*copilot (said|dijo):?\s*/i, '').trim();
}

// ============================================================================
//  BUCLE DEL SERVICIO
// ============================================================================
async function serviceLoop(page) {
  console.log('\n============================================================');
  console.log('  💬  SERVICIO COPILOT ACTIVO');
  console.log('     Escribe tu mensaje y pulsa ENTER.');
  console.log('     /new  -> iniciar un chat nuevo');
  console.log('     /exit -> cerrar el servicio');
  console.log('============================================================\n');

  while (true) {
    const msg = await ask('🗨️  Tú > ');
    if (!msg) continue;
    if (msg === '/exit') break;

    if (msg === '/new') {
      const nuevo = page.getByRole('link', { name: /nuevo chat|new chat/i });
      await nuevo.first().click().catch(() => {});
      await selectModel(page, CONFIG.model); // re-aplica el modelo en el chat nuevo
      ok('Nuevo chat iniciado.');
      continue;
    }

    try {
      process.stdout.write('🤖 Copilot está pensando...\n');
      const reply = await sendMessageAndGetReply(page, msg);
      console.log('\n🤖 Copilot >\n' + reply + '\n');
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
      channel: CONFIG.browserChannel, // 'msedge'
      headless: CONFIG.headless,
      args: [
        '--inprivate',              // MODO INPRIVATE (incógnito) de EDGE
        '--guest',                  // refuerza: sin perfil ni datos guardados
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
  } catch (e) {
    console.error('❌ No se pudo iniciar Microsoft Edge.');
    console.error('   Asegúrate de tener Edge instalado y ejecuta: npx playwright install msedge');
    console.error('   Detalle:', e.message);
    rl.close();
    process.exit(1);
  }

  // Contexto EFÍMERO y SIN estado (incógnito puro).
  const context = await browser.newContext({
    storageState: undefined,   // sin cookies/tokens previos
    ignoreHTTPSErrors: true,
  });
  await context.clearCookies().catch(() => {});
  const page = await context.newPage();

  // --- Login con reintentos del flujo completo ---
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
    console.error('❌ No fue posible completar el login tras varios intentos.');
    await browser.close();
    rl.close();
    process.exit(1);
  }

  // --- Selección de modelo ---
  await selectModel(page, CONFIG.model);

  // --- Servicio interactivo ---
  await serviceLoop(page);

  // --- Cierre ---
  ok('Cerrando servicio...');
  await browser.close();
  rl.close();
  process.exit(0);
})();