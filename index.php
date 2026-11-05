<?php
/**
 * StockMaster BD - Self-Contained cPanel Entry Point (LiteSpeed & Apache)
 * Directly embeds compiled CSS & JS from disk when present so external path/MIME/.htaccess
 * issues on cPanel hosting can never block React from mounting.
 */

// 1. Auto-restore .htaccess on cPanel if missing so /smart and /api/* always route properly
$rootHtaccess = __DIR__ . '/.htaccess';
if (!is_file($rootHtaccess) || filesize($rootHtaccess) < 100) {
    if (is_file(__DIR__ . '/htaccess.txt') && filesize(__DIR__ . '/htaccess.txt') >= 100) {
        @copy(__DIR__ . '/htaccess.txt', $rootHtaccess);
    } elseif (is_file(__DIR__ . '/public/.htaccess') && filesize(__DIR__ . '/public/.htaccess') >= 100) {
        @copy(__DIR__ . '/public/.htaccess', $rootHtaccess);
    } else {
        $defaultHtaccess = <<<'HTACCESS'
Options -MultiViews -Indexes
DirectoryIndex index.php index.html
ErrorDocument 404 /index.php
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteRule (^|/)(env\.php|erp_persistent_state\.json|package(-lock)?\.json|composer\.(json|lock)|tsconfig\.json|vite\.config\.ts|server\.ts)$ - [F,L]
    RewriteRule \.(sql|md|lock|env|example|log|bak|ini|sh|yml|yaml)$ - [F,L]
    RewriteRule ^/?backend/(config|controllers|middleware|repositories|services|validators)/ - [F,L]
    RewriteRule ^/?install\.php$ - [L]
    RewriteRule ^/?api/install\.php$ - [L]
    RewriteRule ^/?backend/api/install\.php$ - [L]
    RewriteRule ^/?api/index\.php$ - [L]
    RewriteRule ^/?backend/api/index\.php$ - [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^/?api/(.*)$ api/index.php?route=$1 [QSA,L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^/?(.+)/assets/(.*)$ assets/$2 [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^/?(.+)/uploads/(.*)$ uploads/$2 [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule ^(.*)$ index.php [QSA,L]
</IfModule>
HTACCESS;
        @file_put_contents($rootHtaccess, $defaultHtaccess);
    }
}

$jsCandidates = [
    __DIR__ . '/assets/app.bundle.js',
    __DIR__ . '/dist/assets/app.bundle.js',
    __DIR__ . '/public/assets/app.bundle.js',
];
$sfJsCandidates = [
    __DIR__ . '/assets/storefront.bundle.js',
    __DIR__ . '/dist/assets/storefront.bundle.js',
    __DIR__ . '/public/assets/storefront.bundle.js',
];
$cssCandidates = [
    __DIR__ . '/assets/app.bundle.css',
    __DIR__ . '/dist/assets/app.bundle.css',
    __DIR__ . '/public/assets/app.bundle.css',
];

$jsFile = '';
foreach ($jsCandidates as $candidate) {
    if (is_file($candidate) && is_readable($candidate) && filesize($candidate) > 1024) {
        $jsFile = $candidate;
        break;
    }
}

$sfJsFile = '';
foreach ($sfJsCandidates as $candidate) {
    if (is_file($candidate) && is_readable($candidate) && filesize($candidate) > 1024) {
        $sfJsFile = $candidate;
        break;
    }
}
if ($sfJsFile === '') {
    $sfJsFile = $jsFile;
}

$cssFile = '';
foreach ($cssCandidates as $candidate) {
    if (is_file($candidate) && is_readable($candidate) && filesize($candidate) > 100) {
        $cssFile = $candidate;
        break;
    }
}

// Direct PHP asset streaming endpoint (?__cpanel_asset=js, ?__cpanel_asset=sfjs, or ?__cpanel_asset=css)
if (isset($_GET['__cpanel_asset'])) {
    $assetType = (string) $_GET['__cpanel_asset'];
    if (($assetType === 'js' || $assetType === 'sfjs') && ($jsFile !== '' || $sfJsFile !== '')) {
        $targetJsFile = ($assetType === 'sfjs' && $sfJsFile !== '') ? $sfJsFile : $jsFile;
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        http_response_code(200);
        header('Content-Type: application/javascript; charset=UTF-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: public, max-age=31536000, immutable');
        $rawJs = @file_get_contents($targetJsFile);
        if ($rawJs !== false && strpos($rawJs, 'import.meta') !== false) {
            $rawJs = str_replace(
                [
                    'function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}',
                    ',void 0,import.meta.url))',
                    'import.meta.url',
                    'import.meta.resolve',
                ],
                [
                    'function s(e){return new URL(e,window.location.href)}',
                    ',void 0,window.location.href))',
                    'window.location.href',
                    'undefined',
                ],
                $rawJs
            );
            echo $rawJs;
        } else {
            readfile($targetJsFile);
        }
        exit;
    }
    if ($assetType === 'css' && $cssFile !== '') {
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        http_response_code(200);
        header('Content-Type: text/css; charset=UTF-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: public, max-age=31536000, immutable');
        readfile($cssFile);
        exit;
    }
    http_response_code(404);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Asset not found on server.';
    exit;
}

http_response_code(200);
header('Content-Type: text/html; charset=UTF-8');
header('Content-Language: en');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('X-XSS-Protection: 1; mode=block');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

$buildTag = 'v560_014e06e6';
$ver = $buildTag . '_' . ($jsFile !== '' ? (string) @filemtime($jsFile) : (string) time());

$scriptName = isset($_SERVER['SCRIPT_NAME']) ? str_replace('\\', '/', (string) $_SERVER['SCRIPT_NAME']) : '/index.php';
$basePath = rtrim(dirname($scriptName), '/.');
if ($basePath === '/' || $basePath === '.') {
    $basePath = '';
}
$assetPrefix = $basePath . '/assets';
$phpEntryPath = ($basePath !== '' ? $basePath : '') . '/index.php';

// Resolve active Storefront Theme, Shop Name, Logo, and Announcement Bar from persistent state on disk
$themePalettes = [
    'emerald_default' => ['from' => '#064E3B', 'via' => '#047857', 'to' => '#065F46', 'primary' => '#064E3B', 'accent' => '#059669', 'softBg' => '#ECFDF5', 'softBorder' => '#A7F3D0', 'pageBg' => '#F8FAFC'],
    'winter_frost'    => ['from' => '#082f49', 'via' => '#0369a1', 'to' => '#1e3a8a', 'primary' => '#0c4a6e', 'accent' => '#0284c7', 'softBg' => '#f0f9ff', 'softBorder' => '#bae6fd', 'pageBg' => '#f0f9ff'],
    'summer_mango'    => ['from' => '#9a3412', 'via' => '#ea580c', 'to' => '#d97706', 'primary' => '#9a3412', 'accent' => '#ea580c', 'softBg' => '#fffbeb', 'softBorder' => '#fde68a', 'pageBg' => '#fffbeb'],
    'ramadan_noor'    => ['from' => '#042f2e', 'via' => '#0f766e', 'to' => '#1e1b4b', 'primary' => '#134e4a', 'accent' => '#d97706', 'softBg' => '#f0fdfa', 'softBorder' => '#99f6e4', 'pageBg' => '#f0fdfa'],
    'eid_festive'     => ['from' => '#4a044e', 'via' => '#7e22ce', 'to' => '#9d174d', 'primary' => '#581c87', 'accent' => '#9333ea', 'softBg' => '#faf5ff', 'softBorder' => '#e9d5ff', 'pageBg' => '#faf5ff'],
    'cool_blue'       => ['from' => '#082f49', 'via' => '#0369a1', 'to' => '#1e3a8a', 'primary' => '#0c4a6e', 'accent' => '#0284c7', 'softBg' => '#f0f9ff', 'softBorder' => '#bae6fd', 'pageBg' => '#f0f9ff'],
    'royal_crimson'   => ['from' => '#4c0519', 'via' => '#881337', 'to' => '#9f1239', 'primary' => '#881337', 'accent' => '#e11d48', 'softBg' => '#fff1f2', 'softBorder' => '#fecdd3', 'pageBg' => '#F8FAFC'],
    'ocean_indigo'    => ['from' => '#172554', 'via' => '#1d4ed8', 'to' => '#1e3a8a', 'primary' => '#1e3a8a', 'accent' => '#2563eb', 'softBg' => '#eff6ff', 'softBorder' => '#bfdbfe', 'pageBg' => '#F8FAFC'],
    'royal_purple'    => ['from' => '#3b0764', 'via' => '#6b21a8', 'to' => '#581c87', 'primary' => '#581c87', 'accent' => '#9333ea', 'softBg' => '#faf5ff', 'softBorder' => '#e9d5ff', 'pageBg' => '#F8FAFC'],
    'sunset_coral'    => ['from' => '#431407', 'via' => '#c2410c', 'to' => '#9a3412', 'primary' => '#7c2d12', 'accent' => '#ea580c', 'softBg' => '#fff7ed', 'softBorder' => '#fed7aa', 'pageBg' => '#F8FAFC'],
    'rose_magenta'    => ['from' => '#500724', 'via' => '#be185d', 'to' => '#831843', 'primary' => '#831843', 'accent' => '#db2777', 'softBg' => '#fdf2f8', 'softBorder' => '#fbcfe8', 'pageBg' => '#F8FAFC'],
    'coffee_bronze'   => ['from' => '#291303', 'via' => '#713f12', 'to' => '#422006', 'primary' => '#422006', 'accent' => '#854d0e', 'softBg' => '#fdf8f6', 'softBorder' => '#eaddd7', 'pageBg' => '#F8FAFC'],
    'luxury_midnight' => ['from' => '#020617', 'via' => '#1e293b', 'to' => '#0f172a', 'primary' => '#0f172a', 'accent' => '#334155', 'softBg' => '#f8fafc', 'softBorder' => '#cbd5e1', 'pageBg' => '#F8FAFC'],
];

$bootThemeKey = 'emerald_default';
$bootShopName = 'কিডস অ্যান্ড ফ্যাশন মার্ট';
$bootLogoUrl = '';
$bootSeoTitle = '';
$bootSeoDesc = 'প্রিমিয়াম বেবি ফ্রক, পার্টি ড্রেস, পাঞ্জাবি ও ফ্যাশন কালেকশন। ১-১২ বছরের বেবি ড্রেস ও সকল সাইজ ভেরিয়েশনে সারাদেশে ক্যাশ অন ডেলিভারি সুবিধা।';
$bootOgImageUrl = '';
$bootTopBarEnabled = true;
$bootTopBarText = 'সারাদেশে ক্যাশ অন ডেলিভারি — প্রোডাক্ট হাতে পেয়ে পেমেন্ট করুন';
$bootPreloaderEnabled = true;
$bootShimmerEnabled = true;

$stateCandidates = [
    __DIR__ . '/backend/config/erp_persistent_state.json',
    __DIR__ . '/backend/erp_persistent_state.json',
];
$applyBizBootMeta = function (array $biz) use (&$bootThemeKey, &$bootShopName, &$bootLogoUrl, &$bootSeoTitle, &$bootSeoDesc, &$bootOgImageUrl, &$bootTopBarEnabled, &$bootTopBarText, &$bootPreloaderEnabled, &$bootShimmerEnabled, $themePalettes) {
    $isWinter = !empty($biz['winterThemeEnabled']) || (($biz['storefrontTheme'] ?? '') === 'winter_frost');
    $candidateTheme = $isWinter ? 'winter_frost' : (string) ($biz['storefrontTheme'] ?? 'emerald_default');
    if (isset($themePalettes[$candidateTheme])) {
        $bootThemeKey = $candidateTheme;
    }
    if (!empty($biz['name'])) {
        $bootShopName = (string) $biz['name'];
    }
    if (!empty($biz['logoUrl']) && trim((string) $biz['logoUrl']) !== '') {
        $bootLogoUrl = trim((string) $biz['logoUrl']);
    }
    if (!empty($biz['seoTitle']) && trim((string) $biz['seoTitle']) !== '') {
        $bootSeoTitle = trim((string) $biz['seoTitle']);
    }
    if (!empty($biz['seoDescription']) && trim((string) $biz['seoDescription']) !== '') {
        $bootSeoDesc = trim((string) $biz['seoDescription']);
    }
    if (!empty($biz['seoOgImageUrl']) && trim((string) $biz['seoOgImageUrl']) !== '') {
        $bootOgImageUrl = trim((string) $biz['seoOgImageUrl']);
    } elseif ($bootLogoUrl !== '') {
        $bootOgImageUrl = $bootLogoUrl;
    }
    if (isset($biz['topAnnouncementEnabled'])) {
        $bootTopBarEnabled = (bool) $biz['topAnnouncementEnabled'];
    }
    if (isset($biz['topAnnouncementText']) && trim((string) $biz['topAnnouncementText']) !== '') {
        $bootTopBarText = trim((string) $biz['topAnnouncementText']);
    }
    if (isset($biz['preloaderEnabled'])) {
        $bootPreloaderEnabled = (bool) $biz['preloaderEnabled'];
    }
    if (isset($biz['preloaderShimmerEnabled'])) {
        $bootShimmerEnabled = (bool) $biz['preloaderShimmerEnabled'];
    }
};

foreach ($stateCandidates as $stateFile) {
    if (is_file($stateFile) && is_readable($stateFile)) {
        $rawJson = @file_get_contents($stateFile);
        if (!empty($rawJson)) {
            $decoded = @json_decode($rawJson, true);
            if (is_array($decoded) && !empty($decoded['businesses'][0]) && is_array($decoded['businesses'][0])) {
                $applyBizBootMeta($decoded['businesses'][0]);
                break;
            }
        }
    }
}

// Also check MySQL app_state_store if logoUrl was not found in disk JSON
if ($bootLogoUrl === '' && is_file(__DIR__ . '/backend/config/Database.php')) {
    try {
        require_once __DIR__ . '/backend/config/Database.php';
        if (class_exists('\\StockMaster\\Config\\Database')) {
            $pdo = \StockMaster\Config\Database::getConnection();
            $stmt = $pdo->query('SELECT state_json FROM app_state_store WHERE id = 1 LIMIT 1');
            $row = $stmt ? $stmt->fetch(\PDO::FETCH_ASSOC) : null;
            if ($row && !empty($row['state_json'])) {
                $decodedDb = @json_decode((string) $row['state_json'], true);
                if (is_array($decodedDb) && !empty($decodedDb['businesses'][0]) && is_array($decodedDb['businesses'][0])) {
                    $applyBizBootMeta($decodedDb['businesses'][0]);
                }
            }
        }
    } catch (\Throwable $e) {
        // Ignore DB errors during initial HTML shell render
    }
}

$effectiveBootLogoSrc = $bootLogoUrl !== '' && strpos($bootLogoUrl, 'FASHION%20MART') === false && strpos($bootLogoUrl, 'FASHION MART') === false ? $bootLogoUrl : '';
if ($effectiveBootLogoSrc !== '') {
    if (strpos($effectiveBootLogoSrc, './uploads/') === 0) {
        $effectiveBootLogoSrc = ($basePath !== '' ? $basePath : '') . '/' . substr($effectiveBootLogoSrc, 2);
    } elseif (strpos($effectiveBootLogoSrc, 'uploads/') === 0) {
        $effectiveBootLogoSrc = ($basePath !== '' ? $basePath : '') . '/' . $effectiveBootLogoSrc;
    }
}

$effectivePageTitle = $bootSeoTitle !== '' ? $bootSeoTitle : ($bootShopName . ' | প্রিমিয়াম বেবি ড্রেস ও ফ্যাশন অনলাইন শপ');
$resolvedBootOgImage = '';
if ($bootOgImageUrl !== '') {
    if (strpos($bootOgImageUrl, 'http://') === 0 || strpos($bootOgImageUrl, 'https://') === 0 || strpos($bootOgImageUrl, 'data:') === 0) {
        $resolvedBootOgImage = $bootOgImageUrl;
    } else {
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host = $_SERVER['HTTP_HOST'] ?? '';
        $resolvedBootOgImage = ($host !== '' ? ($scheme . '://' . $host) : '') . (strpos($bootOgImageUrl, '/') === 0 ? '' : '/') . $bootOgImageUrl;
    }
}

$activePal = $themePalettes[$bootThemeKey] ?? $themePalettes['emerald_default'];
$reqUri = strtolower((string) ($_SERVER['REQUEST_URI'] ?? ''));
$isAdminRoute = strpos($reqUri, '/smart') !== false || isset($_GET['smart']) || (($_GET['route'] ?? '') === 'smart');
$hasStorefrontBundle = ($sfJsFile !== '' && basename($sfJsFile) === 'storefront.bundle.js');
$primaryBundleFile = (!$isAdminRoute && $hasStorefrontBundle) ? 'storefront.bundle.js' : 'app.bundle.js';
$primaryAssetParam = (!$isAdminRoute && $hasStorefrontBundle) ? 'sfjs' : 'js';

$bootStatusLabel = 'লোড হচ্ছে...';
if (strpos($reqUri, '/landing') !== false || strpos($reqUri, 'landing=') !== false) {
    $bootStatusLabel = 'অফার পেজ লোড হচ্ছে...';
} elseif ($isAdminRoute) {
    $bootStatusLabel = 'ড্যাশবোর্ড লোড হচ্ছে...';
}
$serverBootMetaJson = json_encode([
    'theme' => $bootThemeKey,
    'shopName' => $bootShopName,
    'logoUrl' => $bootLogoUrl,
    'topBarEnabled' => $bootTopBarEnabled,
    'topBarText' => $bootTopBarText,
    'preloaderEnabled' => $bootPreloaderEnabled,
    'preloaderShimmerEnabled' => $bootShimmerEnabled,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
?>
<!doctype html>
<html lang="en" translate="no" class="notranslate">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google" content="notranslate" />
    <meta http-equiv="Content-Language" content="en" />
    <title><?= htmlspecialchars($effectivePageTitle, ENT_QUOTES, 'UTF-8') ?></title>
    <meta name="description" content="<?= htmlspecialchars($bootSeoDesc, ENT_QUOTES, 'UTF-8') ?>" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="<?= htmlspecialchars($effectivePageTitle, ENT_QUOTES, 'UTF-8') ?>" />
    <meta property="og:description" content="<?= htmlspecialchars($bootSeoDesc, ENT_QUOTES, 'UTF-8') ?>" />
    <?php if ($resolvedBootOgImage !== ''): ?>
    <meta property="og:image" content="<?= htmlspecialchars($resolvedBootOgImage, ENT_QUOTES, 'UTF-8') ?>" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="<?= htmlspecialchars($resolvedBootOgImage, ENT_QUOTES, 'UTF-8') ?>" />
    <?php endif; ?>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Noto+Sans+Bengali:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" media="print" onload="this.media='all'">
    <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Noto+Sans+Bengali:wght@400;600;700;800&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap"></noscript>
    <link rel="stylesheet" href="<?= htmlspecialchars($assetPrefix, ENT_QUOTES, 'UTF-8') ?>/app.bundle.css?v=<?= htmlspecialchars($ver, ENT_QUOTES, 'UTF-8') ?>" onerror="this.onerror=function(){this.onerror=null;this.href='<?= htmlspecialchars($phpEntryPath, ENT_QUOTES, 'UTF-8') ?>?__cpanel_asset=css&v=<?= htmlspecialchars($ver, ENT_QUOTES, 'UTF-8') ?>';};this.href='./assets/app.bundle.css?v=<?= htmlspecialchars($ver, ENT_QUOTES, 'UTF-8') ?>';">
    <style>
      @keyframes smBootSpin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      @keyframes smBootPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.55; }
      }
      #sm-boot-shell {
        --boot-from: <?= $activePal['from'] ?>;
        --boot-via: <?= $activePal['via'] ?>;
        --boot-to: <?= $activePal['to'] ?>;
        --boot-primary: <?= $activePal['primary'] ?>;
        --boot-accent: <?= $activePal['accent'] ?>;
        --boot-soft-bg: <?= $activePal['softBg'] ?>;
        --boot-soft-border: <?= $activePal['softBorder'] ?>;
        --boot-page-bg: <?= $activePal['pageBg'] ?>;
        min-height: 100vh;
        background: var(--boot-page-bg);
        font-family: 'Plus Jakarta Sans', 'Noto Sans Bengali', sans-serif;
        color: #0f172a;
      }
      .sm-boot-shimmer {
        animation: smBootPulse 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      }
      #sm-boot-shimmer-grid {
        display: <?= $bootShimmerEnabled ? 'grid' : 'none' ?>;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        width: 100%;
        max-width: 1120px;
        margin-top: 34px;
      }
      @media (min-width: 1024px) {
        #sm-boot-shimmer-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 18px;
        }
      }
      .sm-boot-card {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
      }
      .sm-boot-box {
        background: #e2e8f0;
        border-radius: 10px;
        animation: smBootPulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
      }
    </style>
  </head>
  <body translate="no" class="notranslate bg-slate-50 text-slate-900 antialiased selection:bg-emerald-600 selection:text-white">
    <div id="root">
      <div id="sm-boot-shell" style="display:<?= $bootPreloaderEnabled ? 'flex' : 'none' ?>;flex-direction:column;align-items:center;justify-content:flex-start;min-height:100vh;padding:64px 20px 48px;">
        <!-- Upper Brand Logo + Loading Status Pill Below (No Icon Box, No Text Name) -->
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:16px;text-align:center;max-width:360px;width:100%;">
          <img
            id="sm-boot-logo-img"
            src="<?= htmlspecialchars($effectiveBootLogoSrc, ENT_QUOTES, 'UTF-8') ?>"
            alt="Logo"
            style="display:<?= $effectiveBootLogoSrc !== '' ? 'block' : 'none' ?>;height:72px;width:auto;max-width:260px;object-fit:contain;filter:drop-shadow(0 4px 12px rgba(15,23,42,0.06));"
          />

          <div id="sm-boot-status" style="display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:800;color:var(--boot-primary);background:var(--boot-soft-bg);padding:8px 18px;border-radius:9999px;border:1px solid var(--boot-soft-border);box-shadow:0 2px 8px rgba(15,23,42,0.05);">
            <span style="width:15px;height:15px;border-radius:50%;border:2.3px solid var(--boot-soft-border);border-top-color:var(--boot-accent);display:inline-block;animation:smBootSpin 0.75s linear infinite;flex-shrink:0;"></span>
            <span id="sm-boot-status-text"><?= htmlspecialchars($bootStatusLabel, ENT_QUOTES, 'UTF-8') ?></span>
          </div>
        </div>

        <!-- 4-Card Shimmer Product Skeleton Grid (ON/OFF controlled) -->
        <div id="sm-boot-shimmer-grid">
          <div class="sm-boot-card">
            <div class="sm-boot-box" style="width:100%;aspect-ratio:1/1;border-radius:12px;"></div>
            <div class="sm-boot-box" style="height:13px;width:82%;border-radius:6px;"></div>
            <div class="sm-boot-box" style="height:11px;width:56%;border-radius:6px;background:#f1f5f9;"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding-top:2px;">
              <div class="sm-boot-box" style="height:15px;width:62px;border-radius:6px;background:var(--boot-soft-bg);"></div>
              <div class="sm-boot-box" style="height:12px;width:38px;border-radius:6px;background:#f1f5f9;"></div>
            </div>
            <div class="sm-boot-box" style="height:34px;width:100%;border-radius:10px;margin-top:2px;"></div>
          </div>
          <div class="sm-boot-card">
            <div class="sm-boot-box" style="width:100%;aspect-ratio:1/1;border-radius:12px;"></div>
            <div class="sm-boot-box" style="height:13px;width:76%;border-radius:6px;"></div>
            <div class="sm-boot-box" style="height:11px;width:62%;border-radius:6px;background:#f1f5f9;"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding-top:2px;">
              <div class="sm-boot-box" style="height:15px;width:62px;border-radius:6px;background:var(--boot-soft-bg);"></div>
              <div class="sm-boot-box" style="height:12px;width:38px;border-radius:6px;background:#f1f5f9;"></div>
            </div>
            <div class="sm-boot-box" style="height:34px;width:100%;border-radius:10px;margin-top:2px;"></div>
          </div>
          <div class="sm-boot-card">
            <div class="sm-boot-box" style="width:100%;aspect-ratio:1/1;border-radius:12px;"></div>
            <div class="sm-boot-box" style="height:13px;width:84%;border-radius:6px;"></div>
            <div class="sm-boot-box" style="height:11px;width:52%;border-radius:6px;background:#f1f5f9;"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding-top:2px;">
              <div class="sm-boot-box" style="height:15px;width:62px;border-radius:6px;background:var(--boot-soft-bg);"></div>
              <div class="sm-boot-box" style="height:12px;width:38px;border-radius:6px;background:#f1f5f9;"></div>
            </div>
            <div class="sm-boot-box" style="height:34px;width:100%;border-radius:10px;margin-top:2px;"></div>
          </div>
          <div class="sm-boot-card">
            <div class="sm-boot-box" style="width:100%;aspect-ratio:1/1;border-radius:12px;"></div>
            <div class="sm-boot-box" style="height:13px;width:78%;border-radius:6px;"></div>
            <div class="sm-boot-box" style="height:11px;width:58%;border-radius:6px;background:#f1f5f9;"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding-top:2px;">
              <div class="sm-boot-box" style="height:15px;width:62px;border-radius:6px;background:var(--boot-soft-bg);"></div>
              <div class="sm-boot-box" style="height:12px;width:38px;border-radius:6px;background:#f1f5f9;"></div>
            </div>
            <div class="sm-boot-box" style="height:34px;width:100%;border-radius:10px;margin-top:2px;"></div>
          </div>
        </div>
      </div>
      <script>
        (function () {
          try {
            var curPath = window.location.pathname || '/';
            var curSearch = window.location.search || '';
            if (/\/index\.php\/(.+)$/i.test(curPath)) {
              var cleanTarget = curPath.replace(/\/index\.php\//i, '/');
              window.history.replaceState(null, '', cleanTarget + curSearch + (window.location.hash || ''));
            }
            var serverMeta = <?= $serverBootMetaJson ?: 'null' ?>;
            var localMeta = null;
            var rawMeta = window.localStorage.getItem('sm_boot_theme_meta_v1');
            if (rawMeta) {
              try { localMeta = JSON.parse(rawMeta); } catch (e) {}
            }
            var hasErpBiz = false;
            var erpLogo = '';
            var erpPreloader = null;
            var erpShimmer = null;
            var rawErp = window.localStorage.getItem('stockmaster_bd_persistent_erp_v2');
            if (rawErp) {
              try {
                var parsedErp = JSON.parse(rawErp);
                var biz = parsedErp && Array.isArray(parsedErp.businesses) ? parsedErp.businesses[0] : null;
                if (biz) {
                  hasErpBiz = true;
                  erpLogo = biz.logoUrl ? String(biz.logoUrl).trim() : '';
                  if (typeof biz.preloaderEnabled === 'boolean') {
                    erpPreloader = biz.preloaderEnabled;
                  }
                  if (typeof biz.preloaderShimmerEnabled === 'boolean') {
                    erpShimmer = biz.preloaderShimmerEnabled;
                  }
                }
              } catch (e) {}
            }
            var stripDemoSvg = function (u) {
              if (!u) return '';
              var s = String(u).trim();
              if (s.indexOf('FASHION%20MART') !== -1 || s.indexOf('FASHION MART') !== -1) return '';
              return s;
            };
            var srvLogo = stripDemoSvg(serverMeta && serverMeta.logoUrl ? serverMeta.logoUrl : '');
            erpLogo = stripDemoSvg(erpLogo);
            var locLogo = stripDemoSvg(localMeta && localMeta.logoUrl ? localMeta.logoUrl : '');
            var bestLogo = srvLogo || (hasErpBiz ? erpLogo : locLogo) || '';
            var effectivePreloader = erpPreloader !== null
              ? erpPreloader
              : (localMeta && typeof localMeta.preloaderEnabled === 'boolean'
                  ? localMeta.preloaderEnabled
                  : (serverMeta && typeof serverMeta.preloaderEnabled === 'boolean'
                      ? serverMeta.preloaderEnabled
                      : true));
            var shellEl = document.getElementById('sm-boot-shell');
            if (shellEl && effectivePreloader === false) {
              shellEl.style.display = 'none';
            }
            var logoEl = document.getElementById('sm-boot-logo-img');
            if (logoEl) {
              if (bestLogo !== '') {
                var cleanLogo = bestLogo;
                if (cleanLogo.indexOf('./uploads/') === 0) {
                  cleanLogo = '/' + cleanLogo.slice(2);
                } else if (cleanLogo.indexOf('uploads/') === 0) {
                  cleanLogo = '/' + cleanLogo;
                }
                logoEl.src = cleanLogo;
                logoEl.style.display = 'block';
              } else {
                logoEl.src = '';
                logoEl.style.display = 'none';
              }
            }
            var effectiveShimmer = erpShimmer !== null
              ? erpShimmer
              : (localMeta && typeof localMeta.preloaderShimmerEnabled === 'boolean'
                  ? localMeta.preloaderShimmerEnabled
                  : (serverMeta && typeof serverMeta.preloaderShimmerEnabled === 'boolean'
                      ? serverMeta.preloaderShimmerEnabled
                      : true));
            var shimmerGridEl = document.getElementById('sm-boot-shimmer-grid');
            if (shimmerGridEl) {
              shimmerGridEl.style.display = effectiveShimmer === false ? 'none' : 'grid';
            }
            if (serverMeta) {
              serverMeta.logoUrl = bestLogo;
              serverMeta.preloaderEnabled = effectivePreloader;
              serverMeta.preloaderShimmerEnabled = effectiveShimmer;
              window.localStorage.setItem('sm_boot_theme_meta_v1', JSON.stringify(serverMeta));
            }
          } catch (e) {}
        })();
      </script>
    </div>
    <script src="<?= htmlspecialchars($assetPrefix . '/' . $primaryBundleFile, ENT_QUOTES, 'UTF-8') ?>?v=<?= htmlspecialchars($ver, ENT_QUOTES, 'UTF-8') ?>"></script>
    <script>
      (function () {
        if (window.__STOCKMASTER_BOOTED__) return;
        var ver = <?= json_encode($ver) ?>;
        var primaryBundle = <?= json_encode($primaryBundleFile) ?>;
        var primaryAssetParam = <?= json_encode($primaryAssetParam) ?>;
        var fallbacks = [
          './assets/' + primaryBundle + '?v=' + ver,
          '/assets/' + primaryBundle + '?v=' + ver,
          <?= json_encode($phpEntryPath) ?> + '?__cpanel_asset=' + primaryAssetParam + '&v=' + ver,
          './assets/app.bundle.js?v=' + ver,
          '/assets/app.bundle.js?v=' + ver,
          <?= json_encode($phpEntryPath . '?__cpanel_asset=js&v=' . $ver) ?>,
          '/index.php?__cpanel_asset=js&v=' + ver
        ];
        var idx = 0;
        function tryNext() {
          if (window.__STOCKMASTER_BOOTED__ || idx >= fallbacks.length) return;
          var s = document.createElement('script');
          s.src = fallbacks[idx++];
          s.onload = function () {
            setTimeout(function () {
              if (!window.__STOCKMASTER_BOOTED__) tryNext();
            }, 250);
          };
          s.onerror = tryNext;
          document.body.appendChild(s);
        }
        tryNext();
      })();
    </script>
  </body>
</html>
