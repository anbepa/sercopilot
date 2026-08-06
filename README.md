# sercopilot

Servicio de automatización para **Microsoft 365 Copilot** usando **Playwright + Microsoft Edge (InPrivate)**.
Permite iniciar sesión automáticamente (con un único paso manual de token/MFA), seleccionar el modelo y mantener un chat interactivo por consola, capturando las respuestas de Copilot en tiempo real.

---

## Requisitos

- Node.js 18+
- Microsoft Edge instalado

## Instalación

```bash
npm init -y
npm install playwright
npx playwright install msedge
```

## Ejecución

```bash
node copilot-service.js
```

> Recomendado: no dejes tus credenciales en el archivo. Expórtalas como variables de entorno:
> ```bash
> export COPILOT_EMAIL="tu_correo@dominio.com"
> export COPILOT_PASSWORD="tu_password"
> node copilot-service.js
> ```

## Comandos dentro del servicio

- Escribe un mensaje y pulsa ENTER para chatear.
- `/new`  -> inicia un chat nuevo (re-aplica el modelo configurado).
- `/exit` -> cierra el servicio.

---

## Cómo funciona

1. **Lanza Edge en modo InPrivate** (`--inprivate --guest`) con un contexto efímero y sin cookies, para que **siempre** se pida login (evita el problema de "sesión ya activa").
2. **Login automático**: escribe correo y contraseña.
3. **Único paso manual**: token / MFA (OTP por consola o aprobación en Authenticator).
4. **Maneja la pantalla "Acceso supervisado"** de Microsoft Defender for Cloud Apps (ver sección siguiente), que puede aparecer antes o después del login.
5. **Selecciona el modelo** configurado en `CONFIG.model`.
6. **Chat interactivo**: envía tu mensaje y captura la respuesta en directo.

---

## Pantalla post-login: "Acceso supervisado" (VERIFICADA EN VIVO)

Tras el login, Microsoft Defender for Cloud Apps intercepta la navegación (dominio `*.access.mcas.ms`) y muestra una pantalla que **hay que automatizar** para poder continuar. Localizadores reales confirmados:

| Elemento    | Localizador real                                                                 |
|-------------|----------------------------------------------------------------------------------|
| **Título**  | `heading` (h2): *"Usar el explorador Edge para obtener un mejor rendimiento al usar aplicaciones empresariales"* |
| **Checkbox**| `checkbox` "Ocultar esta notificación en todas las aplicaciones durante una semana" |
| **Botón**   | `button` **"Continuar en current browser"**                                      |
| **Pie**     | "Microsoft Defender for Cloud Apps" + enlaces Términos / Privacidad               |

**Automatización aplicada:**
1. Detectar el botón *"Continuar en current browser"*.
2. **Marcar** el checkbox de ocultar (para que no reaparezca durante una semana).
3. Hacer clic en el botón → redirige a **M365 Copilot** (`m365.cloud.microsoft*`).

> Nota: esta pantalla puede aparecer **antes o después** del login, por eso `handleSupervisedAccess()` se invoca en ambos momentos. Tras marcar "ocultar por una semana" y con sesión activa, **no vuelve a mostrarse** dentro de la misma sesión.

---

## Selectores reales del DOM (verificados)

La captura de respuestas se basa en atributos `data-testid` reales del chat de Copilot:

| `data-testid`                 | Uso                                             |
|-------------------------------|-------------------------------------------------|
| `MessageListContainer`        | Contenedor de la lista de mensajes              |
| `m365-chat-llm-web-ui-chat-message` | Cada mensaje individual                    |
| `copilot-message-div`         | Contenedor de una respuesta de Copilot (contar) |
| `copilot-message-reply-div`   | Cuerpo de la respuesta (texto)                  |
| `lastChatMessage`             | Última respuesta                                |
| `loading-message`             | ⚠️ Ver nota crítica más abajo                    |

**Nota importante:** los mensajes son `div[role="article"]` **sin `aria-label`**; el texto "Copilot said:" está en un `<h6>` interno. Por eso NO sirve `getByRole('article', { name: /copilot said/ })`; hay que usar los `data-testid`.

Además, la caja de entrada es un **`textbox` "Enviar un mensaje a Copilot"** (`contenteditable`), no un `<textarea>` clásico.

---

## ⚠️ Bug crítico corregido: cuelgue en "Copilot está pensando..."

**Causa raíz (verificada en vivo):** el elemento `data-testid="loading-message"` **NO es un spinner** y **NO desaparece** al terminar la respuesta. De hecho **contiene el texto final de la respuesta** y permanece `visible` en el DOM. La lógica anterior esperaba a que ese elemento se fuera (`!loading-message`), por lo que se quedaba **colgada para siempre**.

**Solución correcta — detección por estabilización de texto:**
1. Contar `copilot-message-div` antes de enviar.
2. Esperar a que aumente el conteo (nueva respuesta ha aparecido).
3. Leer el texto de `lastChatMessage` en intervalos y considerar **terminada** la respuesta cuando el texto **deja de crecer** durante N lecturas iguales (`stableReads`).
4. Señal de refuerzo: el `textbox` de entrada vuelve a estar **editable** (`aria-disabled !== "true"`).
5. Limpiar el prefijo "Copilot said/dijo:".

> Nunca esperar a `!loading-message`. No usar ese elemento como indicador de "streaming en curso".

---

## Configuración

Edita el objeto `CONFIG` en `copilot-service.js`:

| Clave               | Descripción                                    |
|---------------------|------------------------------------------------|
| `url`               | URL del chat de Copilot                        |
| `email` / `password`| Credenciales (mejor por variables de entorno)  |
| `model`             | Nombre del modelo a seleccionar                |
| `headless`          | `false` para ver el navegador (necesario MFA)  |
| `loginMaxRetries`   | Reintentos del flujo de login                  |
| `responseTimeoutMs` | Tiempo máx. de espera por respuesta            |
| `stableReads`       | Nº de lecturas iguales para dar por terminada la respuesta |
| `stableIntervalMs`  | Intervalo entre lecturas de estabilización     |
