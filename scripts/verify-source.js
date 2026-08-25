const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const textTools = require('../src/text-tools');
const proTools = require('../src/pro-tools');
const subscription = require('../src/subscription');
const {
  requestProjectOidcToken,
  supersededReleaseUrls,
  resolveBlobAuthentication,
  resolveBlobStoreId,
  resolveBlobToken,
} = require('./publish-update-blobs');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const fail = (message) => { throw new Error(message); };

const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const mainSource = read('src/main.js');
const typingEngineSource = read('src/typing-engine.js');
const windowsHostSource = read('src/windows-host.ps1');
const shortcutSource = read('src/shortcut-utils.js');
const shortcutSmokeSource = read('scripts/smoke-shortcuts-electron.js');
const preloadSource = read('src/preload.js');
const quickSource = read('src/quick.js');
const quickMarkup = read('src/quick.html');
const indexMarkup = read('src/index.html');
const indexSource = read('src/index.js');
const subscriptionSource = read('src/subscription.js');
const entitlements = read('build/entitlements.mac.plist');
const releaseWorkflow = read('.github/workflows/release.yml');
const blobPublisher = read('scripts/publish-update-blobs.js');
const updateHostConfig = JSON.parse(read('updates-host/vercel.json'));
const websiteBillingSource = read('website/api/_billing.js');
const websiteBilling = require('../website/api/_billing');
const checkoutSource = read('website/api/create-checkout.js');
const claimSource = read('website/api/claim-entitlement.js');
const refreshSource = read('website/api/refresh-entitlement.js');
const portalSource = read('website/api/create-portal.js');
const checkoutStatusSource = read('website/api/checkout-status.js');
const websiteMarkup = read('website/index.html');
const websiteSuccess = read('website/success.html');
const websiteDownloads = read('website/downloads.js');
const websiteLegal = read('website/legal.html');
const websitePrivacy = read('website/privacy.html');
const websiteTerms = read('website/terms.html');
const websiteRefunds = read('website/refunds.html');
const websiteSupport = read('website/support.html');
const websiteSupportClient = read('website/support.js');
const websiteSupportApi = read('website/api/support-ticket.js');
const websiteTicketStore = read('website/server/tickets.js');
const websiteAccountStore = read('website/server/accounts.js');
const websiteAccount = read('website/account.html');
const websiteAccountClient = read('website/account.js');
const websiteAccountAuth = read('website/api/_auth.js');
const websiteAdmin = read('website/admin.html');
const websiteAdminClient = read('website/admin.js');
const websiteNavigation = read('website/navigation.js');
const websiteNotFound = read('website/404.html');
const websiteStripeWebhook = read('website/api/stripe-webhook.js');
const websiteSitemap = read('website/sitemap.xml');
const websiteVercelConfig = JSON.parse(read('website/vercel.json'));
const websitePackage = JSON.parse(read('website/package.json'));
const websitePackageLock = JSON.parse(read('website/package-lock.json'));
const appIconSource = read('assets/brand/zap/logo/zap-icon.svg');
const websiteIconSource = read('website/brand/zap/zap-icon.svg');

if (!websitePackage.private || packageJson.dependencies?.['@clerk/backend'] ||
    websitePackage.dependencies?.['@clerk/backend']) {
  fail('Clerk must not remain in the first-party Zap account implementation.');
}
if (websitePackage.dependencies?.['@vercel/blob'] !== packageJson.devDependencies['@vercel/blob']) {
  fail('The website must install the pinned private Blob dependency in its Vercel project root.');
}
if (websitePackageLock.packages?.['']?.dependencies?.['@vercel/blob'] !==
      websitePackage.dependencies['@vercel/blob']) {
  fail('The website runtime dependency lock does not match its Vercel package manifest.');
}

const websiteApiFunctions = fs.readdirSync(path.join(root, 'website/api'))
  .filter((name) => name.endsWith('.js'));
if (websiteApiFunctions.length > 12) {
  fail(`Vercel Hobby deployments support at most 12 API functions; found ${websiteApiFunctions.length}.`);
}
for (const [source, destination] of Object.entries({
  '/api/account-config': '/api/account?action=config',
  '/api/register': '/api/account?action=register',
  '/api/login': '/api/account?action=login',
  '/api/logout': '/api/account?action=logout',
  '/api/recover-account': '/api/account?action=recover',
  '/api/account-status': '/api/account?action=status',
  '/api/create-account-portal': '/api/account?action=portal',
  '/api/create-app-activation': '/api/account?action=activation',
  '/api/admin-tickets': '/api/account?action=tickets',
})) {
  if (!websiteVercelConfig.rewrites?.some((rewrite) =>
    rewrite.source === source && rewrite.destination === destination)) {
    fail(`Account API rewrite is missing: ${source}`);
  }
}

if (!packageJson.private || packageJson.license !== 'UNLICENSED') {
  fail('The package must remain private and proprietary.');
}
if (appIconSource !== websiteIconSource || /stroke-opacity|fill="none"\s+stroke=/.test(appIconSource)) {
  fail('The Zap app icon must stay synchronized and free of an outer border.');
}
if (packageJson.version !== packageLock.version || packageJson.version !== packageLock.packages[''].version) {
  fail('package.json and package-lock.json versions do not match.');
}
for (const [group, dependencies] of Object.entries({
  dependencies: packageJson.dependencies,
  devDependencies: packageJson.devDependencies
})) {
  for (const [name, version] of Object.entries(dependencies || {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      fail(`${group}.${name} must be pinned to an exact version.`);
    }
    if (packageLock.packages['']?.[group]?.[name] !== version) {
      fail(`${group}.${name} does not match the lockfile root.`);
    }
  }
}
if (!packageJson.build?.asar || packageJson.build?.compression !== 'maximum') {
  fail('Production packaging must use maximum-compression ASAR.');
}
if (!packageJson.build?.mac?.forceCodeSigning || !packageJson.build?.mac?.hardenedRuntime) {
  fail('macOS signing and Hardened Runtime must remain mandatory.');
}
if (packageJson.build?.mac?.icon !== 'assets/icon.icns') {
  fail('macOS builds must use the verified multi-resolution borderless icon.');
}
if (packageJson.build?.win?.target?.[0]?.target !== 'nsis' ||
    !packageJson.build?.win?.target?.[0]?.arch?.includes('x64') ||
    packageJson.build?.win?.artifactName !== 'Drip-Type-${version}-windows.${ext}') {
  fail('Windows x64 NSIS packaging must remain enabled with the stable artifact name.');
}
if (!packageJson.build?.protocols?.some(({ schemes }) => schemes?.includes('driptype')) ||
    !packageJson.build?.asarUnpack?.includes('build-app/*.ps1')) {
  fail('Cross-platform activation or the unpacked Windows typing host is missing.');
}
if (!entitlements.includes('com.apple.security.cs.allow-jit')) {
  fail('Electron requires the JIT entitlement when Hardened Runtime is enabled.');
}
if (entitlements.includes('com.apple.security.cs.disable-library-validation') ||
    entitlements.includes('com.apple.security.cs.allow-dyld-environment-variables') ||
    entitlements.includes('com.apple.security.cs.allow-unsigned-executable-memory')) {
  fail('Unsafe Hardened Runtime entitlement is enabled.');
}
if (packageJson.build.files.some((entry) => entry.includes('src'))) {
  fail('Raw source must not be included in production packages.');
}
const updateProvider = packageJson.build?.publish?.[0];
if (updateProvider?.provider !== 'generic' || updateProvider?.url !== 'https://drip-type-updates.vercel.app/') {
  fail('The verified updater must use the dedicated public update service.');
}
if (!packageJson.build?.releaseInfo?.releaseName?.includes(packageJson.version) ||
    !packageJson.build?.releaseInfo?.releaseNotes) {
  fail('Release metadata must include the current version name and user-visible notes.');
}
if (!indexMarkup.includes(`Version ${packageJson.version}`)) {
  fail('Native application fallback version must match the package version.');
}
const currentDownload = `Drip-Type-${packageJson.version}-mac.dmg`;
const currentWindowsDownload = `Drip-Type-${packageJson.version}-windows.exe`;
if (!websiteMarkup.includes(`"softwareVersion":"${packageJson.version}"`) ||
    !websiteMarkup.includes(currentDownload) || !websiteMarkup.includes(currentWindowsDownload) ||
    !websiteSuccess.includes(currentDownload) || !websiteDownloads.includes(currentWindowsDownload)) {
  fail('Website release metadata and download links must match the application version.');
}
const releaseMirrorPrefix = `https://github.com/Salt30/drip-type-releases/releases/download/v${packageJson.version}/`;
for (const extension of ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap']) {
  const name = `Drip-Type-${packageJson.version}-mac.${extension}`;
  const redirect = updateHostConfig.redirects?.find(({ source }) => source === `/${name}`);
  if (redirect?.destination !== `${releaseMirrorPrefix}${name}` || redirect?.permanent !== false) {
    fail(`The public updater fallback is missing or incorrect for ${name}.`);
  }
}
for (const extension of ['exe', 'exe.blockmap']) {
  const name = `Drip-Type-${packageJson.version}-windows.${extension}`;
  const redirect = updateHostConfig.redirects?.find(({ source }) => source === `/${name}`);
  if (redirect?.destination !== `${releaseMirrorPrefix}${name}` || redirect?.permanent !== false) {
    fail(`The public updater fallback is missing or incorrect for ${name}.`);
  }
}

for (const marker of ['launchAtLogin', 'wasOpenedAtLogin', "handleTrusted('clipboard:read-text'"]) {
  if (!mainSource.includes(marker)) fail(`Background composer requirement is missing: ${marker}`);
}
for (const marker of [
  "hotkeyStart: 'Alt+5'", 'shortcutDefaultsMigratedToOption5',
  "previous.accelerator === 'Alt+4'", 'validateShortcutPair',
  'attemptShortcutRegistration', 'replaceShortcutPair', 'hasShortcutChange'
]) {
  if (!mainSource.includes(marker)) fail(`Option+5 composer shortcut migration is missing: ${marker}`);
}
for (const marker of ['registerShortcutPair', 'rollbackResult', 'rollbackSuccess']) {
  if (!shortcutSource.includes(marker)) fail(`Transactional shortcut registration is missing: ${marker}`);
}
for (const marker of ['globalShortcut.isRegistered', 'replaceShortcutPair', 'Option+5']) {
  if (!shortcutSmokeSource.includes(marker)) fail(`Native shortcut smoke test is missing: ${marker}`);
}
for (const marker of [
  'acceleratorFromKeyboardEvent', 'captureShortcut', 'reset-shortcuts',
  'Save to apply it everywhere', 'await flushBehavior()'
]) {
  if (!indexMarkup.includes(marker) && !read('src/index.js').includes(marker)) {
    fail(`Working customization control is missing: ${marker}`);
  }
}
for (const marker of ['autoDownload = false', '6 * 60 * 60 * 1000', 'notifyUpdateAvailable']) {
  if (!mainSource.includes(marker)) fail(`In-app update requirement is missing: ${marker}`);
}
for (const marker of ['buildCharacterSteps', 'renderAppleScript', 'validateTypingEvents']) {
  if (!typingEngineSource.includes(marker)) fail(`Shared typing engine requirement is missing: ${marker}`);
}
for (const marker of ['SendInput', 'KEYEVENTF_UNICODE', "ValidateSet('Target', 'Restore', 'Type')", 'SetForegroundWindow', '[Console]::In.ReadToEnd()']) {
  if (!windowsHostSource.includes(marker)) fail(`Native Windows typing requirement is missing: ${marker}`);
}
if (windowsHostSource.includes('Invoke-Expression')) fail('The Windows typing host must never execute user text.');
if (windowsHostSource.includes('PlanPath') || mainSource.includes("mkdtempSync(path.join(os.tmpdir(), 'drip-type-')")) {
  fail('Typing content must stream through protected process input instead of temporary files.');
}
for (const marker of ['app.enableSandbox()', ".replace(/\\r\\n?/g, '\\n')", 'Rejected untrusted IPC sender.']) {
  if (!mainSource.includes(marker)) fail(`Application hardening requirement is missing: ${marker}`);
}
for (const marker of ['encryptedUserVault', 'safeStorage.encryptString', 'publicSettings()', "child.stdin.end(input, 'utf8')"]) {
  if (!mainSource.includes(marker)) fail(`Local privacy hardening requirement is missing: ${marker}`);
}
if (mainSource.includes('store.store') || mainSource.includes("store.set('clipboardWorkspace'") ||
    mainSource.includes("store.set('templates'") || mainSource.includes("store.set('profiles'")) {
  fail('Private local data or the complete settings store must not be exposed in plaintext.');
}
for (const marker of [
  "handleTrusted('billing:get-state'",
  "handleTrusted('billing:refresh'",
  "handleTrusted('billing:portal'",
  'deleteRefreshCredential',
  'shouldRevokeEntitlement(error.status)',
  'paidAccessSeen',
  'navigateMainWindow',
  "window.webContents.once('did-finish-load', navigate)",
  'setAsDefaultProtocolClient(BILLING_SCHEME)',
  'TRIAL_KEYCHAIN_SERVICE',
  "'/usr/bin/security'",
  'safeStorage.encryptString',
  'encryptedRefreshCredential'
]) {
  if (!mainSource.includes(marker)) fail(`Subscription security requirement is missing: ${marker}`);
}
for (const marker of ['"template_library"', '"batch"', '"writing_lab"', 'STRIPE_PRO_PRICE_ID']) {
  if (!websiteBillingSource.includes(marker)) fail(`Website Pro entitlement requirement is missing: ${marker}`);
}
for (const [name, source] of [
  ['checkout', checkoutSource],
  ['refresh', refreshSource],
  ['portal', portalSource]
]) {
  if (!source.includes('hasExactKeys')) fail(`Website ${name} API must reject unexpected fields.`);
}
if (!claimSource.includes('has been retired') || !checkoutStatusSource.includes('has been retired')) {
  fail('Legacy checkout-session activation and public status lookup must remain retired.');
}
if (checkoutSource.includes('{CHECKOUT_SESSION_ID}') || !checkoutSource.includes('/account?purchase=complete')) {
  fail('Checkout success must return to the signed-in account without exposing a session identifier.');
}
for (const marker of [`Pro is live in version ${packageJson.version.replace(/\.0$/, '')}`, 'data-checkout-plan="pro"', '>$25<', '/brand/zap/zap-icon-192.png']) {
  if (!websiteMarkup.includes(marker)) fail(`Website Pro launch requirement is missing: ${marker}`);
}
for (const marker of [
  'Typing speed', 'Start delay', 'Corrected typos', 'Thinking pauses', 'Speed bursts',
  'One shortcut. Every app.', 'What ships today', 'Download for Windows', 'Verified releases'
]) {
  if (!websiteMarkup.includes(marker)) fail(`Website verified-product showcase is missing: ${marker}`);
}
for (const marker of ['mobile-menu-button', 'aria-expanded="false"', '/navigation.js']) {
  if (!websiteMarkup.includes(marker)) fail(`Accessible mobile navigation is missing: ${marker}`);
}
const websiteCsp = websiteVercelConfig.headers?.flatMap(({ headers }) => headers || [])
  .find(({ key }) => key === 'Content-Security-Policy')?.value || '';
const jsonLdBody = websiteMarkup.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] || '';
const jsonLdHash = `sha256-${crypto.createHash('sha256').update(jsonLdBody).digest('base64')}`;
if (websiteCsp.includes("script-src 'self' 'unsafe-inline'") || !websiteCsp.includes(`'${jsonLdHash}'`)) {
  fail('Website CSP must block inline executable scripts while allowing only the exact structured-data hash.');
}
if (/<script(?![^>]*type="application\/ld\+json")(?![^>]*\bsrc=)[^>]*>/i.test(websiteMarkup)) {
  fail('Website homepage contains an inline executable script.');
}
for (const marker of ['Escape', 'restoreFocus', 'matchMedia']) {
  if (!websiteNavigation.includes(marker)) fail(`Mobile navigation behavior is incomplete: ${marker}`);
}
for (const marker of ['ERROR 404', 'noindex,nofollow', '/support', '/account']) {
  if (!websiteNotFound.includes(marker)) fail(`Custom 404 requirement is missing: ${marker}`);
}
const websiteDirectory = path.join(root, 'website');
const websiteHtmlFiles = fs.readdirSync(websiteDirectory).filter((name) => name.endsWith('.html'));
for (const htmlName of websiteHtmlFiles) {
  const html = read(`website/${htmlName}`);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const reference = match[1];
    if (reference.startsWith('#')) {
      if (reference.length > 1 && !ids.has(reference.slice(1))) {
        fail(`Website ${htmlName} has a broken same-page link: ${reference}`);
      }
      continue;
    }
    if (!reference.startsWith('/') || reference.startsWith('//') || reference.startsWith('/api/')) continue;
    const pathname = reference.split(/[?#]/u, 1)[0];
    const relative = pathname.slice(1);
    const candidates = pathname === '/'
      ? ['index.html']
      : path.extname(relative)
        ? [relative]
        : [`${relative}.html`, path.join(relative, 'index.html')];
    if (!candidates.some((candidate) => fs.existsSync(path.join(websiteDirectory, candidate)))) {
      fail(`Website ${htmlName} links to a missing local resource: ${reference}`);
    }
  }
}
if (websiteMarkup.includes('Pause instantly')) {
  fail('Website must not claim a pause/resume control that the application does not provide.');
}
for (const forbidden of ['data-rhythm-preset=', 'Steady</button>', 'Natural</button>', 'Expressive</button>', 'zap-brand-kit.zip']) {
  if (websiteMarkup.includes(forbidden)) fail(`Website contains removed marketing UI or private brand-kit access: ${forbidden}`);
}
for (const forbidden of ['data-preset=', 'class="preset"', "querySelectorAll('.preset')"]) {
  if (indexMarkup.includes(forbidden) || indexSource.includes(forbidden)) {
    fail(`Application contains removed typing preset UI: ${forbidden}`);
  }
}
if (!websiteMarkup.includes('name="google-site-verification"')) {
  fail('Google Search Console ownership verification must remain in the production homepage.');
}
for (const marker of ['/legal', 'renew monthly until canceled', 'By completing checkout', '/privacy', '/terms', '/refunds']) {
  if (!websiteMarkup.includes(marker)) fail(`Website legal disclosure is missing: ${marker}`);
}
for (const marker of ['/support', 'Support']) {
  if (!websiteMarkup.includes(marker)) fail(`Website support entry point is missing: ${marker}`);
}
for (const marker of [
  'id="support-form"', 'name="privacyAccepted"', 'name="companyWebsite"',
  '/api/support-ticket', 'crypto.randomUUID()', '/privacy'
]) {
  if (!websiteSupport.includes(marker) && !websiteSupportClient.includes(marker)) {
    fail(`Website support intake requirement is missing: ${marker}`);
  }
}
for (const marker of [
  'id="reset-code"', 'id="reset-password"', '/api/recover-account',
  'reset-strength-meter', 'minlength="15"', 'recoveryCode'
]) {
  if (!websiteAccount.includes(marker) && !websiteAccountClient.includes(marker)) {
    fail(`Account password recovery requirement is missing: ${marker}`);
  }
}
for (const marker of [
  'STRIPE_WEBHOOK_SECRET', 'stripe-signature', 'createHmac("sha256"',
  'SIGNATURE_TOLERANCE_SECONDS', 'bodyParser: false', 'customer.subscription.deleted',
  'zap_account_id', 'stripeEventCreated'
]) {
  if (!websiteStripeWebhook.includes(marker)) fail(`Stripe webhook security requirement is missing: ${marker}`);
}
for (const marker of ['metadata[zap_account_id]', 'subscription_data[metadata][zap_account_id]']) {
  if (!checkoutSource.includes(marker)) fail(`Checkout account-link metadata is missing: ${marker}`);
}
for (const marker of ['hasExactKeys', 'RATE_LIMIT', 'configuredOrigin', 'ticketStore.createTicket']) {
  if (!websiteSupportApi.includes(marker)) fail(`Secure support intake requirement is missing: ${marker}`);
}
for (const marker of ['access: "private"', 'allowOverwrite: false', 'ifMatch:', 'support-tickets/']) {
  if (!websiteTicketStore.includes(marker)) fail(`Private support storage requirement is missing: ${marker}`);
}
for (const marker of ['aes-256-gcm', 'SUPPORT_DATA_KEY', 'RETENTION_MS', 'result.hasMore', 'purgeExpiredTickets']) {
  if (!websiteTicketStore.includes(marker)) fail(`Encrypted support retention requirement is missing: ${marker}`);
}
for (const marker of ['ADMIN_EMAILS', 'ADMIN_USER_IDS', 'requireAdmin', 'accountForRequest']) {
  if (!websiteAccountAuth.includes(marker)) fail(`Admin authentication requirement is missing: ${marker}`);
}
for (const marker of [
  'AUTH_MASTER_KEY', 'aes-256-gcm', 'scrypt', '__Host-zap_session', 'HttpOnly', 'SameSite=Lax',
  'allowOverwrite: options.create ? false : true', 'ifMatch:', 'MAX_LOGIN_FAILURES', 'LOCKOUT_MS', 'recoveryHash',
  'sessionVersion', 'timingSafeEqual'
]) {
  if (!websiteAccountStore.includes(marker)) fail(`First-party account security requirement is missing: ${marker}`);
}
if (/clerk/iu.test(websiteAccount + websiteAccountClient + websiteAccountAuth + websiteAdminClient +
    websitePrivacy + websiteTerms + websiteLegal + JSON.stringify(websiteVercelConfig))) {
  fail('Clerk must not remain in the website, account, admin, legal, or security boundary.');
}
for (const marker of ['Private admin', 'id="ticket-list"', 'id="ticket-update"', '/api/admin-tickets']) {
  if (!websiteAdmin.includes(marker) && !websiteAdminClient.includes(marker)) {
    fail(`Support admin console requirement is missing: ${marker}`);
  }
}
if (/RESEND_API_KEY|api\.resend\.com|<strong>Resend<\/strong>/.test(
  websiteSupportApi + websitePrivacy + websiteLegal
)) {
  fail('Resend must not remain in the support-ticket flow or current legal disclosures.');
}
if (websiteSupport.includes('support@tryzap.net') || websiteSupportClient.includes('support@tryzap.net')) {
  fail('The public support form must not expose its server-side delivery address.');
}
if (!websiteSitemap.includes('https://tryzap.net/support')) {
  fail('The support page is missing from the sitemap.');
}
for (const [name, source, markers] of [
  ['legal center', websiteLegal, ['VegaNext LLC', 'Private support form', 'Subscription summary', '/privacy', '/terms', '/refunds']],
  ['privacy policy', websitePrivacy, ['Effective August 25, 2026', 'Version 2.7', 'Information we collect and why', 'support form', 'encrypted private account', 'salted scrypt', 'We do not sell personal information', 'Your privacy rights', 'Windows Data Protection API', 'AES-256-GCM', '90 days', 'VegaNext LLC']],
  ['terms', websiteTerms, ['Effective August 22, 2026', 'Paid subscriptions and renewal', 'up to three devices', 'Governing law and disputes', 'These Terms do not require arbitration']],
  ['refund policy', websiteRefunds, ['Effective August 22, 2026', 'Cancel online at any time', '14 calendar days', 'Renewal charges and partial periods', 'private support form']]
]) {
  for (const marker of markers) {
    if (!source.includes(marker)) fail(`Website ${name} requirement is missing: ${marker}`);
  }
}
for (const marker of [
  'id="auth-form"', 'type="email"', 'type="password"', 'minlength="15"',
  'id="strength-meter"', 'id="connect-app"', '/privacy', '/terms'
]) {
  if (!websiteAccount.includes(marker)) fail(`Website account requirement is missing: ${marker}`);
}
for (const marker of [
  '/api/register', '/api/login', '/api/logout', '/api/recover-account',
  '/api/account-status', '/api/create-checkout', '/api/create-app-activation',
  'credentials: "same-origin"'
]) {
  if (!websiteAccountClient.includes(marker)) fail(`Website account flow is missing: ${marker}`);
}
for (const marker of ['accountForRequest', 'storageConfigured', 'validAccountId']) {
  if (!websiteAccountAuth.includes(marker)) fail(`Website account authentication boundary is missing: ${marker}`);
}
for (const marker of [
  'customer: customer.id', 'client_reference_id: account.userId',
  'Idempotency-Key', 'accountSubscription(account)', 'createPortalSession(customer.id)',
  'openCheckoutForCustomer(customer.id)', 'expires_at'
]) {
  if (!checkoutSource.includes(marker)) fail(`Account-bound checkout protection is missing: ${marker}`);
}
for (const marker of [
  "handleTrusted('pro:batch-render'", "handleTrusted('pro:transform'",
  "handleTrusted('profiles:save'", "handleTrusted('clipboard-workspace:capture'",
  "proRequired('clipboard')", 'MAX_CLIPBOARD_COUNT'
]) {
  if (!mainSource.includes(marker)) fail(`Pro enforcement requirement is missing: ${marker}`);
}
for (const marker of ['ENTITLEMENT_PUBLIC_KEY', 'createPublicKey', 'verifyEntitlement', 'deviceHash']) {
  if (!subscriptionSource.includes(marker)) fail(`Signed entitlement verification is missing: ${marker}`);
}
for (const marker of ['id="page-billing"', 'id="billing-status"', 'id="billing-manage"']) {
  if (!indexMarkup.includes(marker)) fail(`Native billing interface is missing: ${marker}`);
}
if (/uses:\s+[^\n]+@(v\d+|main|master|latest)\b/.test(releaseWorkflow) ||
    /vercel@latest\b/.test(releaseWorkflow)) {
  fail('Release dependencies must be pinned to immutable versions.');
}
if (releaseWorkflow.includes('git fetch') ||
    !releaseWorkflow.includes('git rev-parse refs/remotes/origin/main') ||
    !releaseWorkflow.includes('RELEASE_TAG="${RELEASE_TAG%%/*}"') ||
    !releaseWorkflow.includes('RELEASE_TAG="${RELEASE_TAG%%-retry-*}"')) {
  fail('Release validation must use the credential-free checkout and support an isolated retry branch.');
}
for (const marker of [
  'runs-on: windows-2025',
  'npm run dist:win',
  'CSC_IDENTITY_AUTO_DISCOVERY: "false"',
  'dist/win-unpacked/Drip Type.exe',
  'dist/latest.yml',
  'Drip-Type-*-windows.exe.blockmap',
  'needs: [mac, windows]'
]) {
  if (!releaseWorkflow.includes(marker)) fail(`Native Windows release verification is missing: ${marker}`);
}
if (releaseWorkflow.includes('cp dist/latest-mac.yml dist/*.dmg')) {
  fail('Large installers must not be copied into the Vercel deployment.');
}
for (const marker of [
  "access: 'public'",
  'multipart: true',
  'cacheControlMaxAge: 31536000',
  "crypto.createHash('sha256')",
  '`releases/v${packageVersion}/${digest}/${name}`',
  'requestProjectOidcToken',
  'resolveBlobAuthentication',
  'resolveBlobStoreId',
  'pruneSupersededReleases'
]) {
  if (!blobPublisher.includes(marker)) fail(`Blob publisher requirement is missing: ${marker}`);
}

assert.equal(
  resolveBlobToken({ BLOB_READ_WRITE_TOKEN: ' vercel_blob_rw_store_secret ' }),
  'vercel_blob_rw_store_secret',
);
assert.equal(
  resolveBlobToken({ DRIP_TYPE_BLOB_READ_WRITE_TOKEN: ' vercel_blob_rw_store_prefixed ' }),
  'vercel_blob_rw_store_prefixed',
);
assert.throws(
  () => resolveBlobToken({
    FIRST_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store_one',
    SECOND_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_store_two',
  }),
  /multiple read-write token variables are configured/,
);

assert.deepEqual(
  supersededReleaseUrls([
    { pathname: `releases/v${packageJson.version}/current.dmg`, url: 'https://blob.invalid/current' },
    { pathname: 'releases/v1.5.0/old.dmg', url: 'https://blob.invalid/old-dmg' },
    { pathname: 'releases/v1.5.0/old.zip', url: 'https://blob.invalid/old-zip' },
    { pathname: 'unrelated/file.bin', url: 'https://blob.invalid/unrelated' }
  ]),
  ['https://blob.invalid/old-dmg', 'https://blob.invalid/old-zip']
);
assert.throws(() => resolveBlobToken({}), /no Blob read-write token is configured/);
assert.equal(resolveBlobStoreId({ BLOB_STORE_ID: ' store_main ' }), 'store_main');
assert.equal(resolveBlobStoreId({ DRIP_TYPE_BLOB_STORE_ID: ' store_prefixed ' }), 'store_prefixed');
assert.equal(resolveBlobStoreId({ BLOB_STORE_ID: 'same', OTHER_BLOB_STORE_ID: 'same' }), 'same');
assert.throws(
  () => resolveBlobStoreId({ FIRST_BLOB_STORE_ID: 'first', SECOND_BLOB_STORE_ID: 'second' }),
  /multiple Blob store IDs are configured/,
);

resolveBlobAuthentication({
  BLOB_STORE_ID: 'production-store',
  VERCEL_OIDC_TOKEN: 'production-oidc',
  VERCEL_TOKEN: 'long-lived-token-must-not-be-used',
}).then((authentication) => {
  assert.deepEqual(authentication, {
    oidcToken: 'production-oidc',
    storeId: 'production-store',
  });
}).catch((error) => {
  setImmediate(() => { throw error; });
});

const oidcRequests = [];
requestProjectOidcToken(
  { accessToken: 'secret-vercel-token', projectId: 'prj_test', orgId: 'team_test' },
  async (url, options) => {
    oidcRequests.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ token: 'short-lived-oidc' }) };
  },
).then((token) => {
  assert.equal(token, 'short-lived-oidc');
  assert.equal(oidcRequests.length, 1);
  assert(oidcRequests[0].url.includes('/v1/projects/prj_test/token'));
  assert(oidcRequests[0].url.includes('teamId=team_test'));
  assert.equal(oidcRequests[0].options.method, 'POST');
  assert.equal(oidcRequests[0].options.headers.authorization, 'Bearer secret-vercel-token');
}).catch((error) => {
  setImmediate(() => { throw error; });
});

const blobTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-update-publish-test-'));
try {
  const blobTestDist = path.join(blobTestRoot, 'dist');
  const blobTestSite = path.join(blobTestRoot, 'site');
  fs.mkdirSync(blobTestDist);
  for (const name of [
    `Drip-Type-${packageJson.version}-mac.dmg`,
    `Drip-Type-${packageJson.version}-mac.dmg.blockmap`,
    `Drip-Type-${packageJson.version}-mac.zip`,
    `Drip-Type-${packageJson.version}-mac.zip.blockmap`,
    `Drip-Type-${packageJson.version}-windows.exe`,
    `Drip-Type-${packageJson.version}-windows.exe.blockmap`
  ]) {
    fs.writeFileSync(path.join(blobTestDist, name), `fixture:${name}`);
  }
  execFileSync(process.execPath, ['scripts/publish-update-blobs.js'], {
    cwd: root,
    env: {
      ...process.env,
      DIST_DIR: blobTestDist,
      UPDATE_SITE_DIR: blobTestSite,
      PUBLISH_UPDATE_DRY_RUN: '1'
    },
    stdio: 'pipe'
  });
  const generatedConfig = JSON.parse(fs.readFileSync(path.join(blobTestSite, 'vercel.json'), 'utf8'));
  assert.equal(generatedConfig.redirects.length, 6);
  assert(generatedConfig.redirects.every(({ destination }) =>
    destination.startsWith(`https://dry-run.invalid/releases/v${packageJson.version}/`)));
} finally {
  fs.rmSync(blobTestRoot, { recursive: true, force: true });
}
if (!preloadSource.includes("ipcRenderer.invoke('clipboard:read-text')")) {
  fail('The isolated clipboard bridge is missing.');
}
for (const marker of ["ipcRenderer.invoke('templates:list')", "ipcRenderer.invoke('templates:save'", "ipcRenderer.invoke('templates:delete'"]) {
  if (!preloadSource.includes(marker)) fail(`The isolated template bridge is missing: ${marker}`);
}
for (const marker of [
  "ipcRenderer.invoke('billing:get-state')",
  "ipcRenderer.invoke('billing:refresh')",
  "ipcRenderer.invoke('billing:portal')",
  "ipcRenderer.on('billing:state'"
]) {
  if (!preloadSource.includes(marker)) fail(`The isolated billing bridge is missing: ${marker}`);
}
for (const marker of ['Drip Composer', 'Private draft · stored in memory only', 'id="paste"']) {
  if (!quickMarkup.includes(marker)) fail(`Composer interface requirement is missing: ${marker}`);
}
if (!quickSource.includes('readClipboardText') || !quickSource.includes('100000')) {
  fail('Composer clipboard input must use the bounded preload bridge.');
}
for (const marker of ['MAX_CORE_TEMPLATE_COUNT', 'MAX_PRO_TEMPLATE_COUNT', "handleTrusted('templates:list'", 'sanitizeTemplate']) {
  if (!mainSource.includes(marker)) fail(`Local template safety requirement is missing: ${marker}`);
}
for (const marker of ['template-picker', 'template-dialog', 'tool-clean', 'tool-bullets']) {
  if (!quickMarkup.includes(`id="${marker}"`)) fail(`Composer local tool is missing: ${marker}`);
}

assert.equal(textTools.cleanSpacing('  Hello   world  \r\n\r\n\r\n Next  '), 'Hello world\n\nNext');
const bulleted = textTools.toggleBulletsText('One\nTwo');
assert.deepEqual(bulleted, { added: true, text: '• One\n• Two' });
assert.deepEqual(textTools.toggleBulletsText(bulleted.text), { added: false, text: 'One\nTwo' });
assert.deepEqual(textTools.variableNames('Hi {{ name }}, {{topic}} / {{name}}'), ['name', 'topic']);
assert.equal(textTools.fillTemplate('Hi {{name}} — {{topic}}', { name: 'Sam', topic: 'launch' }), 'Hi Sam — launch');
assert.equal(textTools.hasUnresolvedVariables('Hi {{name}}'), true);
assert.equal(textTools.hasUnresolvedVariables('Hi Sam'), false);
const batch = proTools.renderBatch('Hi {{name}} — {{topic}}', 'name,topic\nSam,Launch\nMaya,"Quarterly, plan"');
assert.deepEqual(batch.outputs.map(({ text }) => text), ['Hi Sam — Launch', 'Hi Maya — Quarterly, plan']);
assert.equal(proTools.renderBatch('Hi {{name}}', 'person\nSam').outputs.length, 0);
assert.match(proTools.renderBatch('Hi {{name}}', 'person\nSam').errors[0], /Missing columns/);
assert.equal(proTools.transformWriting('I just wanted to maybe share this.', 'direct'), 'share this.');
assert.equal(proTools.transformWriting('One. Two?', 'outline'), '• One.\n• Two?');
assert.deepEqual(proTools.searchClipboard([{ text: 'Launch note' }, { text: 'Invoice' }], 'launch'), [{ text: 'Launch note' }]);

const trialStart = Date.now() - 2 * 24 * 60 * 60 * 1000;
const trialState = subscription.accessState({
  token: '',
  deviceId: '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b',
  trialStartedAt: trialStart,
  now: Date.now()
});
assert.equal(trialState.allowed, true);
assert.equal(trialState.status, 'trial');
assert.equal(trialState.daysRemaining, 12);
const expiredTrialState = subscription.accessState({
  token: '',
  deviceId: '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b',
  trialStartedAt: trialStart - subscription.TRIAL_LENGTH_MS,
  now: Date.now()
});
assert.equal(expiredTrialState.allowed, false);
assert.equal(expiredTrialState.status, 'required');
assert.equal(subscription.shouldRevokeEntitlement(401), true);
assert.equal(subscription.shouldRevokeEntitlement(402), true);
assert.equal(subscription.shouldRevokeEntitlement(403), true);
assert.equal(subscription.shouldRevokeEntitlement(409), false);
assert.equal(subscription.shouldRevokeEntitlement(503), false);

assert.deepEqual(
  websiteBilling.parseBody({ body: '{"plan":"pro"}' }, 64),
  { plan: 'pro' },
);
assert.equal(websiteBilling.hasExactKeys({ plan: 'pro' }, ['plan']), true);
assert.equal(websiteBilling.hasExactKeys({ plan: 'pro', admin: true }, ['plan']), false);
assert.equal(websiteBilling.hasExactKeys({ sessionId: 'one' }, ['sessionId', 'deviceId']), false);
assert.equal(websiteBilling.isJsonRequest({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true);
assert.equal(websiteBilling.isJsonRequest({ headers: { 'content-type': 'text/plain' } }), false);
assert.throws(() => websiteBilling.parseBody({ body: '[]' }), /JSON object/);
assert.throws(() => websiteBilling.parseBody({ body: { plan: 'pro', data: 'x'.repeat(80) } }, 64), /too large/);

const { privateKey: testPrivateKey, publicKey: testPublicKey } = crypto.generateKeyPairSync('ed25519');
const nowSeconds = Math.floor(Date.now() / 1000);
const testDevice = '3b9d5ef5-b71a-4cc0-a3aa-5ad5da015a2b';
const testHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'drip-type-v1', typ: 'JWT' })).toString('base64url');
const testPayload = Buffer.from(JSON.stringify({
  v: 1,
  iss: 'https://tryzap.net',
  aud: 'com.salt30.driptype',
  sub: 'test-subscription',
  plan: 'core',
  features: ['composer', 'typing', 'hotkeys', 'templates', 'updates'],
  device: subscription.deviceHash(testDevice),
  iat: nowSeconds,
  exp: nowSeconds + 60 * 60
})).toString('base64url');
const testInput = `${testHeader}.${testPayload}`;
const testSignature = crypto.sign(null, Buffer.from(testInput), testPrivateKey).toString('base64url');
const testToken = `${testInput}.${testSignature}`;
const testPublicKeyEncoded = testPublicKey.export({ format: 'der', type: 'spki' }).toString('base64');
assert.equal(subscription.verifyEntitlement(testToken, testDevice, Date.now(), testPublicKeyEncoded).plan, 'core');
const proPayload = Buffer.from(JSON.stringify({
  ...JSON.parse(Buffer.from(testPayload, 'base64url').toString('utf8')),
  plan: 'pro',
  features: ['composer', 'typing', 'hotkeys', 'templates', 'updates', 'profiles', 'clipboard', 'template_library', 'batch', 'writing_lab']
})).toString('base64url');
const proInput = `${testHeader}.${proPayload}`;
const proSignature = crypto.sign(null, Buffer.from(proInput), testPrivateKey).toString('base64url');
const proEntitlement = subscription.verifyEntitlement(`${proInput}.${proSignature}`, testDevice, Date.now(), testPublicKeyEncoded);
assert.equal(proEntitlement.plan, 'pro');
assert.equal(proEntitlement.features.includes('batch'), true);
const previousSigningKey = process.env.ENTITLEMENT_PRIVATE_KEY;
process.env.ENTITLEMENT_PRIVATE_KEY = testPrivateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const issuedPro = websiteBilling.signedEntitlement({ id: 'sub_live_pro_fixture' }, 'pro', testDevice);
const verifiedIssuedPro = subscription.verifyEntitlement(issuedPro.token, testDevice, Date.now(), testPublicKeyEncoded);
assert.equal(verifiedIssuedPro.plan, 'pro');
assert.deepEqual(verifiedIssuedPro.features, [
  'composer', 'typing', 'hotkeys', 'templates', 'updates', 'profiles', 'clipboard',
  'template_library', 'batch', 'writing_lab'
]);
if (previousSigningKey === undefined) delete process.env.ENTITLEMENT_PRIVATE_KEY;
else process.env.ENTITLEMENT_PRIVATE_KEY = previousSigningKey;
const tamperedPayload = Buffer.from(JSON.stringify({
  ...JSON.parse(Buffer.from(testPayload, 'base64url').toString('utf8')),
  plan: 'pro'
})).toString('base64url');
assert.throws(
  () => subscription.verifyEntitlement(`${testHeader}.${tamperedPayload}.${testSignature}`, testDevice, Date.now(), testPublicKeyEncoded),
  /Invalid entitlement signature/
);

const pages = [
  ['src/index.html', 'src/index.js'],
  ['src/quick.html', 'src/quick.js'],
  ['src/onboarding.html', 'src/onboarding.js']
];

for (const [htmlPath, jsPath] of pages) {
  const html = read(htmlPath);
  const js = read(jsPath);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) fail(`${htmlPath} contains a duplicate element ID.`);

  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  if (!csp.includes("default-src 'self'") || !csp.includes("script-src 'self'") ||
      !csp.includes("connect-src 'none'") || csp.includes("'unsafe-eval'")) {
    fail(`${htmlPath} has an unsafe or incomplete Content Security Policy.`);
  }
  if (/<script(?!\s+src=)[^>]*>/i.test(html)) fail(`${htmlPath} contains an inline script.`);

  const referencedIds = [
    ...js.matchAll(/\$\('([^']+)'\)/g),
    ...js.matchAll(/getElementById\('([^']+)'\)/g)
  ].map((match) => match[1]);
  for (const id of referencedIds) {
    if (!ids.includes(id)) fail(`${jsPath} references missing element #${id}.`);
  }
}

const forbiddenExtensions = new Set(['.p12', '.pfx', '.cer', '.pem', '.key', '.mobileprovision']);
const forbiddenNames = new Set(['.env', '.env.local', '.npmrc', 'project.json']);
const excludedDirectories = new Set(['node_modules', 'dist', 'build-app', '.git', '.vercel']);
const secretPatterns = [
  ['Stripe live key', new RegExp(['[rs]k', 'live', '[A-Za-z0-9_]{16,}'].join('[_]'))],
  ['Stripe webhook secret', new RegExp(['whsec', '[A-Za-z0-9]{16,}'].join('[_]'))],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', new RegExp(['-----BEGIN', '(?: RSA| EC| OPENSSH)?', ' PRIVATE KEY-----'].join(''))],
  ['Apple app-specific password', /\b[a-z]{4}(?:-[a-z]{4}){3}\b/]
];
const textExtensions = new Set(['', '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.plist', '.sh', '.txt', '.yml', '.yaml']);
function scan(directory, baseDirectory = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) scan(absolutePath, baseDirectory);
    else {
      const relativePath = path.relative(baseDirectory, absolutePath);
      const extension = path.extname(entry.name).toLowerCase();
      if (forbiddenExtensions.has(extension) || forbiddenNames.has(entry.name)) {
        fail(`Credential material must not be stored in the repository: ${relativePath}`);
      }
      if (!textExtensions.has(extension) || fs.statSync(absolutePath).size > 2_000_000) continue;
      const source = fs.readFileSync(absolutePath, 'utf8').replace(/xxxx-xxxx-xxxx-xxxx/g, '');
      for (const [label, pattern] of secretPatterns) {
        if (pattern.test(source)) fail(`${label} detected in ${relativePath}.`);
      }
    }
  }
}

const credentialScanTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-credential-scan-test-'));
try {
  fs.mkdirSync(path.join(credentialScanTestRoot, '.vercel'));
  fs.writeFileSync(path.join(credentialScanTestRoot, '.vercel', 'project.json'), '{"projectId":"prj_test"}\n');
  assert.doesNotThrow(() => scan(credentialScanTestRoot));

  fs.writeFileSync(path.join(credentialScanTestRoot, 'project.json'), '{"projectId":"prj_test"}\n');
  assert.throws(
    () => scan(credentialScanTestRoot),
    /Credential material must not be stored in the repository: project\.json/
  );
} finally {
  fs.rmSync(credentialScanTestRoot, { recursive: true, force: true });
}
scan(root);

console.log('Source, UI, security, and packaging configuration verification passed.');
