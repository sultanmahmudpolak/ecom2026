import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import { 
  initialBusinesses, 
  initialOutlets, 
  initialProducts, 
  initialCustomers, 
  initialSuppliers, 
  initialSalesReps, 
  initialAccounts, 
  initialSales, 
  initialPurchases, 
  initialExpenses,
  initialOnlineOrders,
  initialUsers
} from './src/data/initialData.ts';
import {
  initVpsSqliteEngine,
  loadStateFromSqlite,
  saveStateToSqlite,
  getSqliteDatabaseBuffer,
  getVpsDatabaseMetrics
} from './src/db/vpsDatabase.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Zero-dependency standard ZIP archive creator (CRC32 + Deflate)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  zipPath: string;
  data: Buffer;
}

function createZipBuffer(entries: ZipEntryInput[]): Buffer {
  // Deduplicate entries by normalized path (last wins)
  const dedupMap = new Map<string, Buffer>();
  for (const entry of entries) {
    const cleanPath = entry.zipPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (cleanPath) {
      dedupMap.set(cleanPath, entry.data);
    }
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  let totalEntries = 0;

  for (const [zipPath, uncompressed] of dedupMap.entries()) {
    const nameBuf = Buffer.from(zipPath, 'utf-8');
    const compressed = zlib.deflateRawSync(uncompressed, { level: 6 });
    const crc = crc32(uncompressed);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    localHeader.writeUInt16LE(20, 4);         // version needed (2.0)
    localHeader.writeUInt16LE(0, 6);          // general purpose bit flag (ASCII paths)
    localHeader.writeUInt16LE(8, 8);          // compression method: deflate (8)
    localHeader.writeUInt16LE(0x4800, 10);    // valid DOS time (09:00:00)
    localHeader.writeUInt16LE(0x5421, 12);    // valid DOS date (2022-01-01)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    centralHeader.writeUInt16LE(20, 4);         // version made by (MS-DOS 2.0 compatible)
    centralHeader.writeUInt16LE(20, 6);         // version needed (2.0)
    centralHeader.writeUInt16LE(0, 8);          // bit flag
    centralHeader.writeUInt16LE(8, 10);         // method: deflate
    centralHeader.writeUInt16LE(0x4800, 12);    // DOS time
    centralHeader.writeUInt16LE(0x5421, 14);    // DOS date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
    totalEntries++;
  }

  const centralDirSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(totalEntries, 8);
  eocd.writeUInt16LE(totalEntries, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function collectDirRecursive(absDir: string, zipPrefix: string, entries: ZipEntryInput[], ignoreDirs: Set<string> = new Set()) {
  if (!fs.existsSync(absDir)) return;
  const items = fs.readdirSync(absDir, { withFileTypes: true });
  for (const item of items) {
    if (ignoreDirs.has(item.name)) continue;
    const fullPath = path.join(absDir, item.name);
    const relZipPath = zipPrefix ? `${zipPrefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      collectDirRecursive(fullPath, relZipPath, entries, ignoreDirs);
    } else if (item.isFile()) {
      entries.push({
        zipPath: relZipPath,
        data: fs.readFileSync(fullPath),
      });
    }
  }
}

const ALLOWED_PROJECT_FILES = new Set([
  'Dockerfile',
  'docker-compose.yml',
  'deployment/coolify_vps_guide.md',
  'src/db/vpsDatabase.ts',
  'database/cpanel_complete_install.sql',
  'database/schema.sql',
  'database/demo_seed.sql',
  'backend/api/install.php',
  'backend/api/index.php',
  'backend/api/.htaccess',
  'public/.htaccess',
  'backend/config/Database.php',
  'backend/middleware/SecurityMiddleware.php',
  'backend/validators/InputValidator.php',
  'backend/repositories/InventoryRepository.php',
  'backend/services/TransactionService.php',
  'backend/controllers/ApiController.php',
  'deployment/cpanel_deployment_guide.md',
  'deployment/backup_restore_guide.md',
  'deployment/environment_configuration_example.txt',
  'README.md',
]);

const PERSISTENT_DATA_DIR = path.join(__dirname, 'data');
const PERSISTENT_STATE_FILE = path.join(PERSISTENT_DATA_DIR, 'erp_persistent_state.json');
const UPLOADS_ROOT_DIR = path.join(__dirname, 'uploads');

const UPLOADS_HTACCESS_CONTENT = `# StockMaster BD - Strict Upload Directory Security (Blocks Script Execution)
Options -Indexes -ExecCGI
<IfModule mod_php.c>
    php_flag engine off
</IfModule>
<IfModule mod_php8.c>
    php_flag engine off
</IfModule>
<IfModule mod_headers.c>
    Header set X-Content-Type-Options "nosniff"
    Header set Cache-Control "public, max-age=31536000, immutable"
</IfModule>
<FilesMatch "\\.(php|php[0-9]|phtml|phar|pl|py|cgi|sh|bash|exe|dll|asp|aspx|jsp|htaccess|htpasswd|ini|env|sql|json|html|htm|js|mjs)$">
    <IfModule mod_authz_core.c>
        Require all denied
    </IfModule>
    <IfModule !mod_authz_core.c>
        Order allow,deny
        Deny from all
    </IfModule>
</FilesMatch>
`;

function ensureUploadsDirectories() {
  try {
    fs.mkdirSync(path.join(UPLOADS_ROOT_DIR, 'products'), { recursive: true });
    fs.mkdirSync(path.join(UPLOADS_ROOT_DIR, 'logos'), { recursive: true });
    const htaccessPath = path.join(UPLOADS_ROOT_DIR, '.htaccess');
    if (!fs.existsSync(htaccessPath)) {
      fs.writeFileSync(htaccessPath, UPLOADS_HTACCESS_CONTENT, 'utf-8');
    }
  } catch {
    // Ignore directory creation errors
  }
}

function verifyImageMagicBytes(buf: Buffer, ext: string): boolean {
  if (!buf || buf.length < 12) return false;
  if (ext === 'webp') {
    return (
      buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP'
    );
  }
  if (ext === 'jpg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (ext === 'png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }
  if (ext === 'gif') {
    const header = buf.slice(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  return false;
}

function saveBase64ImageToDisk(
  dataUrl: string,
  folder: 'products' | 'logos' = 'products',
  thumbDataUrl?: string
): string | null {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return null;
  }
  const match = dataUrl.match(/^data:image\/(webp|jpeg|jpg|png|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;

  const rawMimeExt = match[1].toLowerCase();
  const ext = rawMimeExt === 'jpeg' ? 'jpg' : rawMimeExt;
  const base64Payload = match[2].replace(/\s+/g, '');
  const buf = Buffer.from(base64Payload, 'base64');

  // Strict size check (min 12 bytes, max 8MB) & magic-byte verification
  if (buf.length < 12 || buf.length > 8 * 1024 * 1024) return null;
  if (!verifyImageMagicBytes(buf, ext)) return null;

  const safeFolder = folder === 'logos' ? 'logos' : 'products';
  ensureUploadsDirectories();

  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);

  if (safeFolder === 'products' && ext === 'webp' && typeof thumbDataUrl === 'string') {
    const thumbMatch = thumbDataUrl.match(/^data:image\/webp;base64,([A-Za-z0-9+/=\s]+)$/i);
    if (thumbMatch) {
      const thumbBuf = Buffer.from(thumbMatch[1].replace(/\s+/g, ''), 'base64');
      if (
        thumbBuf.length >= 12 &&
        thumbBuf.length <= 4 * 1024 * 1024 &&
        verifyImageMagicBytes(thumbBuf, 'webp')
      ) {
        const hdFileName = `hd_${hash}.webp`;
        const thumbFileName = `hd_${hash}_thumb.webp`;
        const hdFullPath = path.join(UPLOADS_ROOT_DIR, safeFolder, hdFileName);
        const thumbFullPath = path.join(UPLOADS_ROOT_DIR, safeFolder, thumbFileName);
        try {
          if (!fs.existsSync(hdFullPath)) {
            fs.writeFileSync(hdFullPath, buf);
          }
          if (!fs.existsSync(thumbFullPath)) {
            fs.writeFileSync(thumbFullPath, thumbBuf);
          }
          const distDir = path.join(__dirname, 'dist');
          if (fs.existsSync(distDir)) {
            const distUploadsDir = path.join(distDir, 'uploads', safeFolder);
            fs.mkdirSync(distUploadsDir, { recursive: true });
            const distHdPath = path.join(distUploadsDir, hdFileName);
            const distThumbPath = path.join(distUploadsDir, thumbFileName);
            if (!fs.existsSync(distHdPath)) fs.writeFileSync(distHdPath, buf);
            if (!fs.existsSync(distThumbPath)) fs.writeFileSync(distThumbPath, thumbBuf);
          }
          return `/uploads/${safeFolder}/${hdFileName}`;
        } catch {
          // Fallback to single image below
        }
      }
    }
  }

  const fileName = `img_${hash}.${ext}`;
  const relUrl = `/uploads/${safeFolder}/${fileName}`;
  const fullPath = path.join(UPLOADS_ROOT_DIR, safeFolder, fileName);

  try {
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, buf);
    }
    const distDir = path.join(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      const distUploadsDir = path.join(distDir, 'uploads', safeFolder);
      fs.mkdirSync(distUploadsDir, { recursive: true });
      const distFilePath = path.join(distUploadsDir, fileName);
      if (!fs.existsSync(distFilePath)) {
        fs.writeFileSync(distFilePath, buf);
      }
    }
    return relUrl;
  } catch {
    return null;
  }
}

function migrateBase64ImagesInState(stateObj: Record<string, any>): boolean {
  let mutated = false;
  const convertField = (val: any, folder: 'products' | 'logos' = 'products'): any => {
    if (typeof val === 'string' && val.startsWith('data:image/')) {
      const savedUrl = saveBase64ImageToDisk(val, folder);
      if (savedUrl) {
        mutated = true;
        return savedUrl;
      }
    }
    return val;
  };

  if (Array.isArray(stateObj.businesses)) {
    for (const biz of stateObj.businesses) {
      if (!biz || typeof biz !== 'object') continue;
      if (typeof biz.logoUrl === 'string' && biz.logoUrl.startsWith('data:image/') && !biz.logoUrl.startsWith('data:image/svg')) {
        biz.logoUrl = convertField(biz.logoUrl, 'logos');
      }
      if (typeof biz.faviconUrl === 'string' && biz.faviconUrl.startsWith('data:image/') && !biz.faviconUrl.startsWith('data:image/svg')) {
        biz.faviconUrl = convertField(biz.faviconUrl, 'logos');
      }
      if (typeof biz.seoOgImageUrl === 'string' && biz.seoOgImageUrl.startsWith('data:image/') && !biz.seoOgImageUrl.startsWith('data:image/svg')) {
        biz.seoOgImageUrl = convertField(biz.seoOgImageUrl, 'logos');
      }
    }
  }

  if (Array.isArray(stateObj.categories)) {
    for (const cat of stateObj.categories) {
      if (!cat || typeof cat !== 'object') continue;
      if (typeof cat.image === 'string' && cat.image.startsWith('data:image/')) {
        cat.image = convertField(cat.image, 'products');
      }
    }
  }

  if (Array.isArray(stateObj.products)) {
    for (const prod of stateObj.products) {
      if (!prod || typeof prod !== 'object') continue;
      if (typeof prod.image === 'string' && prod.image.startsWith('data:image/')) {
        prod.image = convertField(prod.image, 'products');
      }
      if (Array.isArray(prod.galleryImages)) {
        prod.galleryImages = prod.galleryImages.map((img: any) => convertField(img, 'products'));
      }
      if (Array.isArray(prod.landingReviewImages)) {
        prod.landingReviewImages = prod.landingReviewImages.map((img: any) => convertField(img, 'products'));
      }
      if (Array.isArray(prod.variants)) {
        for (const v of prod.variants) {
          if (v && typeof v === 'object' && typeof v.imageUrl === 'string' && v.imageUrl.startsWith('data:image/')) {
            v.imageUrl = convertField(v.imageUrl, 'products');
          }
        }
      }
      if (Array.isArray(prod.landingReviewItems)) {
        for (const rev of prod.landingReviewItems) {
          if (rev && typeof rev === 'object' && Array.isArray(rev.images)) {
            rev.images = rev.images.map((img: any) => convertField(img, 'products'));
          }
        }
      }
    }
  }

  return mutated;
}

const db: Record<string, any> = {
  updatedAt: 0,
  businesses: [...initialBusinesses],
  outlets: [...initialOutlets],
  products: [...initialProducts],
  customers: [...initialCustomers],
  customerLedger: [] as any[],
  suppliers: [...initialSuppliers],
  salesReps: [...initialSalesReps],
  accounts: [...initialAccounts],
  sales: [...initialSales],
  onlineOrders: [...initialOnlineOrders],
  incompleteOrders: [] as any[],
  deletedIncompleteOrderIds: [] as string[],
  saleReturns: [] as any[],
  purchases: [...initialPurchases],
  purchaseReturns: [] as any[],
  expenses: [...initialExpenses],
  stockTransfers: [] as any[],
  stockAdjustments: [] as any[],
  stockMovements: [] as any[],
  auditLogs: [] as any[],
  dayEndClosures: [] as any[],
  users: [] as any[],
  heldCarts: [] as any[]
};

const DEFAULT_ADMIN_PASSWORD_HASH =
  'sha256$sm2026init$ad5a01d11fb52cc2f3b52a28701f794d8712cf945f4544a3b1d5e8761f97e3de';

function hashUserPasswordTs(rawPassword: string): string {
  const clean = String(rawPassword || '');
  if (clean.startsWith('sha256$') && clean.split('$').length === 3) {
    return clean;
  }
  const salt = crypto.randomBytes(8).toString('hex');
  const digest = crypto.createHash('sha256').update(`${salt}:${clean}`, 'utf8').digest('hex');
  return `sha256$${salt}$${digest}`;
}

function verifyUserPasswordTs(rawPassword: string, storedHashOrPlain?: string): boolean {
  const input = String(rawPassword || '');
  if (!input) return false;
  const stored = String(storedHashOrPlain || '').trim() || DEFAULT_ADMIN_PASSWORD_HASH;

  if (stored.startsWith('sha256$')) {
    const parts = stored.split('$');
    if (parts.length === 3) {
      const [, salt, expectedHex] = parts;
      const actualHex = crypto.createHash('sha256').update(`${salt}:${input}`, 'utf8').digest('hex');
      if (expectedHex.length === actualHex.length) {
        return crypto.timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(actualHex, 'utf8'));
      }
    }
    return false;
  }

  // Compatibility with legacy seed bcrypt placeholder if present
  if (stored === '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi') {
    return verifyUserPasswordTs(input, DEFAULT_ADMIN_PASSWORD_HASH);
  }

  // Fallback for legacy unmigrated plaintext password before first save
  return stored === input;
}

function stripUserPasswordsForClientTs(usersList: any[]): any[] {
  if (!Array.isArray(usersList)) return [];
  return usersList.map((u: any) => {
    if (!u || typeof u !== 'object') return u;
    const { password, passwordHash, password_hash, ...safeUser } = u;
    return safeUser;
  });
}

function mergeAndHashUsersTs(existingUsers: any[], incomingUsers?: any[]): any[] {
  const baseUsers =
    Array.isArray(existingUsers) && existingUsers.length > 0 ? existingUsers : [...initialUsers];
  const existingMap = new Map<string, any>();
  for (const u of [...initialUsers, ...baseUsers]) {
    if (!u || typeof u !== 'object') continue;
    const key = String(u.id || u.username || '').trim();
    if (!key) continue;
    const prev = existingMap.get(key) || {};
    const rawPass = typeof u.password === 'string' ? u.password.trim() : '';
    const existingHash =
      String(u.passwordHash || u.password_hash || prev.passwordHash || prev.password_hash || '').trim();
    const resolvedHash = rawPass
      ? hashUserPasswordTs(rawPass)
      : existingHash || DEFAULT_ADMIN_PASSWORD_HASH;
    const { password, password_hash, ...rest } = u;
    existingMap.set(key, {
      ...prev,
      ...rest,
      passwordHash: resolvedHash
    });
  }

  if (!Array.isArray(incomingUsers) || incomingUsers.length === 0) {
    return Array.from(existingMap.values());
  }

  const existingByUsername = new Map<string, any>();
  for (const val of existingMap.values()) {
    if (val?.username) {
      existingByUsername.set(String(val.username).trim().toLowerCase(), val);
    }
  }

  const result: any[] = [];
  const seenIds = new Set<string>();

  for (const inc of incomingUsers) {
    if (!inc || typeof inc !== 'object') continue;
    const idKey = String(inc.id || '').trim();
    const unameKey = String(inc.username || '').trim().toLowerCase();
    const prev =
      (idKey && existingMap.get(idKey)) ||
      (unameKey && existingByUsername.get(unameKey)) ||
      null;

    const rawNewPass = typeof inc.password === 'string' ? inc.password.trim() : '';
    const prevHash = String(
      prev?.passwordHash || prev?.password_hash || inc.passwordHash || inc.password_hash || ''
    ).trim();
    const resolvedHash = rawNewPass
      ? hashUserPasswordTs(rawNewPass)
      : prevHash || DEFAULT_ADMIN_PASSWORD_HASH;

    const { password, password_hash, ...cleanInc } = inc;
    const mergedUser = {
      ...(prev || {}),
      ...cleanInc,
      passwordHash: resolvedHash
    };
    const finalKey = String(mergedUser.id || mergedUser.username || '').trim();
    if (finalKey && !seenIds.has(finalKey)) {
      seenIds.add(finalKey);
      result.push(mergedUser);
    }
  }

  return result.length > 0 ? result : Array.from(existingMap.values());
}

db.users = mergeAndHashUsersTs(initialUsers, []);

function loadDbFromDisk() {
  ensureUploadsDirectories();
  initVpsSqliteEngine(PERSISTENT_DATA_DIR);

  try {
    const sqliteState = loadStateFromSqlite();
    let jsonState: Record<string, any> | null = null;

    if (fs.existsSync(PERSISTENT_STATE_FILE)) {
      try {
        const raw = fs.readFileSync(PERSISTENT_STATE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          jsonState = parsed;
        }
      } catch {
        // Ignore corrupt JSON if SQLite has valid state
      }
    }

    // Choose whichever state is newer (or migrate existing JSON into SQLite WAL on first boot)
    const sqliteTs = Number(sqliteState?.updatedAt || 0);
    const jsonTs = Number(jsonState?.updatedAt || 0);
    const chosenState =
      sqliteState && sqliteTs >= jsonTs ? sqliteState : jsonState || sqliteState;

    if (chosenState && typeof chosenState === 'object') {
      const hadPlaintextUserPassword =
        Array.isArray(chosenState.users) &&
        chosenState.users.some((u: any) => u && typeof u.password === 'string' && u.password.trim() !== '');
      Object.assign(db, chosenState);
      db.users = mergeAndHashUsersTs(initialUsers, Array.isArray(chosenState.users) ? chosenState.users : []);
      // Migrate untouched legacy grocery or 20-item seed catalog to clean Baby Dress & Fashion catalog
      if (
        Array.isArray(db.products) &&
        db.products.some(
          (p: any) =>
            p?.sku === 'OIL-TEER-5L' ||
            p?.sku === 'RICE-MINIKET-50' ||
            p?.sku === 'FASH-PANJABI-01' ||
            p?.sku === 'FASH-WATCH-10'
        )
      ) {
        const customProducts = db.products.filter(
          (p: any) => !/^prod_(0[1-9]|1[0-9]|20)$/.test(String(p?.id || ''))
        );
        db.products = [...initialProducts, ...customProducts];
      }
      // Automatically migrate any stored Base64 product/logo images or plaintext user passwords
      const migratedImages = migrateBase64ImagesInState(db);
      if (!sqliteState || sqliteTs < jsonTs || migratedImages || hadPlaintextUserPassword) {
        saveDbToDisk();
      }
    } else {
      // Seed initial state into SQLite WAL & JSON disk
      saveDbToDisk();
    }
  } catch (err) {
    console.error('[StockMaster BD] Warning: could not load persisted state:', err);
  }
}

function saveDbToDisk() {
  try {
    if (!fs.existsSync(PERSISTENT_DATA_DIR)) {
      fs.mkdirSync(PERSISTENT_DATA_DIR, { recursive: true });
    }
    db.users = mergeAndHashUsersTs(initialUsers, Array.isArray(db.users) ? db.users : []);
    // 1. Save atomically to High-Speed SQLite3 (WAL Mode)
    saveStateToDiskSqliteAndJson();
  } catch (err) {
    console.error('[StockMaster BD] Warning: could not save persisted state:', err);
  }
}

function saveStateToDiskSqliteAndJson() {
  saveStateToSqlite(db);
  fs.writeFileSync(PERSISTENT_STATE_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

loadDbFromDisk();

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isProduction =
    process.env.NODE_ENV === 'production' ||
    process.env.npm_lifecycle_event === 'start';

  app.disable('x-powered-by');
  app.use(express.json({ limit: '15mb' }));

  // Global Security Headers & Automatic Brotli/Gzip JSON API Compression
  app.use((req: Request, res: Response, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const origJson = res.json.bind(res);
    res.json = ((body: any) => {
      try {
        const acceptEncoding = String(req.headers['accept-encoding'] || '');
        const jsonStr = JSON.stringify(body);
        if (jsonStr && jsonStr.length > 1024 && !res.getHeader('Content-Encoding')) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Vary', 'Accept-Encoding');
          if (acceptEncoding.includes('br') && typeof zlib.brotliCompressSync === 'function') {
            const compressed = zlib.brotliCompressSync(Buffer.from(jsonStr, 'utf-8'), {
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
            });
            res.setHeader('Content-Encoding', 'br');
            res.setHeader('Content-Length', String(compressed.length));
            return res.send(compressed);
          } else if (acceptEncoding.includes('gzip')) {
            const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'), { level: 6 });
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Content-Length', String(compressed.length));
            return res.send(compressed);
          }
        }
      } catch {
        // Fallback to standard JSON response
      }
      return origJson(body);
    }) as any;

    next();
  });

  // Cryptographic Admin Session Token & Cookie Guard for cPanel Code & File Downloads
  const ADMIN_SESSION_SECRET =
    process.env.ADMIN_SESSION_SECRET ||
    'sm_bd_cpanel_download_hmac_secret_2026_' + String(DEFAULT_ADMIN_PASSWORD_HASH).slice(-24);
  const revokedAdminTokens = new Set<string>();

  const createAdminSessionTokenTs = (userId: string, role: string): string => {
    const ts = Date.now();
    const cleanUid = String(userId || 'user_01').replace(/[^a-zA-Z0-9_-]/g, '');
    const cleanRole = String(role || 'super_admin').replace(/[^a-zA-Z0-9_-]/g, '');
    const payload = `${ts}.${cleanUid}.${cleanRole}`;
    const sig = crypto
      .createHmac('sha256', ADMIN_SESSION_SECRET)
      .update(payload, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return `sm_adm_${payload}.${sig}`;
  };

  const extractAdminTokenFromReqTs = (req: Request): string => {
    const hdrToken = String(
      req.headers['x-admin-token'] ||
        req.headers['x-csrf-token'] ||
        String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        ''
    ).trim();
    if (hdrToken) return hdrToken;

    const rawCookies = String(req.headers.cookie || '');
    const cookieMatch = rawCookies.match(/(?:^|;\s*)sm_admin_sid=([^;]+)/);
    if (cookieMatch && cookieMatch[1]) {
      try {
        return decodeURIComponent(cookieMatch[1].trim());
      } catch {
        return cookieMatch[1].trim();
      }
    }
    return '';
  };

  const verifyAdminDownloadAuthTs = (req: Request): boolean => {
    const token = extractAdminTokenFromReqTs(req);
    if (token && !revokedAdminTokens.has(token) && token.startsWith('sm_adm_')) {
      const rawBody = token.slice('sm_adm_'.length);
      const parts = rawBody.split('.');
      if (parts.length === 4) {
        const [tsStr, uid, role, sig] = parts;
        const ts = Number(tsStr) || 0;
        // Valid for 7 days
        if (ts > 0 && Date.now() - ts < 7 * 24 * 60 * 60 * 1000) {
          const expectedSig = crypto
            .createHmac('sha256', ADMIN_SESSION_SECRET)
            .update(`${tsStr}.${uid}.${role}`, 'utf8')
            .digest('hex')
            .slice(0, 32);
          if (sig.length === expectedSig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
            return true;
          }
        }
      }
    }

    return false;
  };

  const requireAdminDownloadAuthTs = (req: Request, res: Response): boolean => {
    if (verifyAdminDownloadAuthTs(req)) {
      return true;
    }
    res.status(401).json({
      success: false,
      error:
        'অনুমোদিত নয়! শুধুমাত্র অ্যাডমিন লগইন করার পরেই cPanel কোড বা ফাইল ডাউনলোড করা যাবে। (401 Unauthorized: Admin login required)'
    });
    return false;
  };

  // 1. Download Ready-to-Upload cPanel public_html ZIP (Compiled Frontend + PHP API + 1-Click Web Installer + MySQL SQL + Uploads)
  app.get('/api/download-cpanel-zip', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    try {
      // Ensure any Base64 images in current state are extracted into physical /uploads/ files before packaging
      ensureUploadsDirectories();
      if (migrateBase64ImagesInState(db)) {
        saveDbToDisk();
      }

      const entries: ZipEntryInput[] = [];

      // Built static React frontend files at root of public_html (excluding index.html so index.php is always the sole entry point on LiteSpeed/Apache)
      collectDirRecursive(
        path.join(__dirname, 'dist'),
        '',
        entries,
        new Set(['aistudio', 'index.html', 'cpanel-app.html'])
      );

      // Guarantee compiled frontend bundles are present and 100% free of import.meta syntax
      for (const bundleName of ['app.bundle.js', 'storefront.bundle.js']) {
        const distBJs = path.join(__dirname, 'dist', 'assets', bundleName);
        const rootBJs = path.join(__dirname, 'assets', bundleName);
        const sourceBJs = fs.existsSync(distBJs) ? distBJs : rootBJs;
        if (fs.existsSync(sourceBJs)) {
          const sanitizedJs = fs
            .readFileSync(sourceBJs, 'utf-8')
            .replace(
              /function\s+s\(e\)\{return\s+import\.meta\.resolve\?new\s+URL\(import\.meta\.resolve\(e\)\):new\s+URL\(e,import\.meta\.url\)\}/g,
              'function s(e){return new URL(e,window.location.href)}'
            )
            .replace(/,void 0,import\.meta\.url\)\)/g, ',void 0,window.location.href))')
            .replace(/import\.meta\.resolve/g, 'undefined')
            .replace(/import\.meta\.url/g, 'window.location.href');
          entries.push({
            zipPath: `assets/${bundleName}`,
            data: Buffer.from(sanitizedJs, 'utf-8'),
          });
        }
      }
      const distBundleCss = path.join(__dirname, 'dist', 'assets', 'app.bundle.css');
      const rootBundleCss = path.join(__dirname, 'assets', 'app.bundle.css');
      const sourceBundleCss = fs.existsSync(distBundleCss) ? distBundleCss : rootBundleCss;
      if (fs.existsSync(sourceBundleCss)) {
        entries.push({
          zipPath: 'assets/app.bundle.css',
          data: fs.readFileSync(sourceBundleCss),
        });
      }

      // Always include .htaccess and htaccess.txt backup
      const publicHtaccessPath = path.join(__dirname, 'public', '.htaccess');
      if (fs.existsSync(publicHtaccessPath)) {
        const htBuf = fs.readFileSync(publicHtaccessPath);
        entries.push({
          zipPath: '.htaccess',
          data: htBuf,
        });
        entries.push({
          zipPath: 'htaccess.txt',
          data: htBuf,
        });
      }

      const rootIndexPhpPath = path.join(__dirname, 'index.php');
      if (fs.existsSync(rootIndexPhpPath)) {
        entries.push({
          zipPath: 'index.php',
          data: fs.readFileSync(rootIndexPhpPath),
        });
      }

      // Include 1-Click Web Installer at BOTH /install.php AND /api/install.php
      const installerPath = path.join(__dirname, 'backend', 'api', 'install.php');
      if (fs.existsSync(installerPath)) {
        const installerBuf = fs.readFileSync(installerPath);
        entries.push({
          zipPath: 'install.php',
          data: installerBuf,
        });
      }

      // PHP public API endpoints inside public_html/api/
      collectDirRecursive(path.join(__dirname, 'backend', 'api'), 'api', entries, new Set(['.htaccess']));

      // Copy cpanel_complete_install.sql into api/ as well so install.php always finds it
      const sqlFullPath = path.join(__dirname, 'database', 'cpanel_complete_install.sql');
      if (fs.existsSync(sqlFullPath)) {
        entries.push({
          zipPath: 'api/cpanel_complete_install.sql',
          data: fs.readFileSync(sqlFullPath),
        });
      }

      // Protected PHP backend classes inside public_html/backend/ (exclude api, subfolder .htaccess, and any legacy .json state files)
      collectDirRecursive(
        path.join(__dirname, 'backend'),
        'backend',
        entries,
        new Set(['api', 'erp_persistent_state.json', 'env.php', '.htaccess'])
      );
      entries.push({
        zipPath: 'backend/index.html',
        data: Buffer.from('', 'utf-8'),
      });

      // Complete 1-Click MySQL database file inside database/ (without conflicting subfolder .htaccess)
      collectDirRecursive(path.join(__dirname, 'database'), 'database', entries, new Set(['.htaccess']));
      collectDirRecursive(path.join(__dirname, 'deployment'), 'deployment', entries, new Set(['.htaccess']));

      // Include physical uploaded product & logo images inside public_html/uploads/ (without subfolder .htaccess)
      collectDirRecursive(UPLOADS_ROOT_DIR, 'uploads', entries, new Set(['.htaccess']));

      // Add a simple Bangla quick-start guide right inside the ZIP root
      const banglaGuide = `====================================================================
StockMaster BD - ১-ক্লিকে cPanel ও MySQL ইনস্টলেশন গাইড
====================================================================

ধাপ ১: এই জিপ ফাইলটি আপনার cPanel -> File Manager -> public_html ফোল্ডারে Upload এবং Extract করুন।
ধাপ ২: আপনার cPanel থেকে একটি নতুন MySQL Database ও User তৈরি করুন (ALL PRIVILEGES সহ)।
ধাপ ৩: আপনার ব্রাউজারে নিচের লিংকে ঢুকুন:
   👉 https://আপনার-ডোমেইন.com/install.php

ধাপ ৪: সেখানে আপনার Database Name, Username ও Password দিয়ে "1-Click Install" বাটনে ক্লিক করলেই সবগুলো টেবিল ও .htaccess ফাইল স্বয়ংক্রিয়ভাবে তৈরি হয়ে যাবে!

ডিফল্ট অ্যাডমিন লগইন:
অ্যাডমিন প্যানেল লিংক: https://আপনার-ডোমেইন.com/smart
ইমেইল/ইউজারনেম: owner@stockflowbd.com (অথবা admin)
পাসওয়ার্ড: Admin@1234
====================================================================\n`;
      entries.push({
        zipPath: 'INSTALL_GUIDE_BANGLA.txt',
        data: Buffer.from(banglaGuide, 'utf-8'),
      });

      const uniqueCount = new Set(
        entries.map(e => e.zipPath.replace(/\\/g, '/').replace(/^\/+/, '')).filter(Boolean)
      ).size;
      const zipBuf = createZipBuffer(entries);
      const filename = 'stockmaster_cpanel_ready_public_html.zip';

      if (req.query.format === 'base64') {
        return res.json({
          success: true,
          filename,
          fileCount: uniqueCount,
          byteSize: zipBuf.length,
          base64: zipBuf.toString('base64'),
        });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(zipBuf.length));
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(zipBuf);
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'Failed to generate cPanel ZIP: ' + (err?.message || 'Unknown error') });
    }
  });

  // 2. Download Complete Full Source Code ZIP (React + TypeScript + PHP + MySQL + Docs)
  app.get('/api/download-source-zip', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    try {
      const entries: ZipEntryInput[] = [];
      const ignore = new Set(['node_modules', '.git', '.aistudio', 'data']);
      collectDirRecursive(__dirname, 'stockmaster-bd-full', entries, ignore);

      const zipBuf = createZipBuffer(entries);
      const filename = 'stockmaster_full_source_code.zip';

      if (req.query.format === 'base64') {
        return res.json({
          success: true,
          filename,
          fileCount: entries.length,
          byteSize: zipBuf.length,
          base64: zipBuf.toString('base64'),
        });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(zipBuf.length));
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(zipBuf);
    } catch (err: any) {
      res.status(500).json({ success: false, error: 'Failed to generate source ZIP: ' + (err?.message || 'Unknown error') });
    }
  });

  // Serve whitelisted PHP/MySQL/Deployment source files for viewing/downloading in UI (Strictly requires Admin Login)
  app.get('/api/project-file', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    const requestedPath = String(req.query.path || '');
    if (!ALLOWED_PROJECT_FILES.has(requestedPath)) {
      return res.status(403).send('Access denied: File not in allowed cPanel package list.');
    }
    try {
      const fullPath = path.join(__dirname, requestedPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (req.query.download === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(requestedPath)}"`);
      }
      res.type('text/plain; charset=utf-8').send(content);
    } catch {
      res.status(404).send('File not found');
    }
  });

  app.get('/api/db-status', (req: Request, res: Response) => {
    const vpsMetrics = getVpsDatabaseMetrics();
    res.json({
      success: true,
      engine: vpsMetrics.engine,
      sqliteAvailable: vpsMetrics.sqliteAvailable,
      walMode: vpsMetrics.walMode,
      dbFileSizeKb: vpsMetrics.dbFileSizeKb,
      lastSavedAt: vpsMetrics.lastSavedAt,
      schemaFileAvailable: true,
      totalProducts: Array.isArray(db.products) ? db.products.length : 0,
      totalOrders: Array.isArray(db.onlineOrders) ? db.onlineOrders.length : 0,
      totalIncompleteOrders: Array.isArray(db.incompleteOrders) ? db.incompleteOrders.length : 0,
      totalSales: Array.isArray(db.sales) ? db.sales.length : 0,
      totalPurchases: Array.isArray(db.purchases) ? db.purchases.length : 0,
      totalCustomers: Array.isArray(db.customers) ? db.customers.length : 0,
      nodeVersion: process.version,
      ramUsedMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      timeZone: 'Asia/Dhaka',
      currency: 'BDT (৳)',
    });
  });

  // Coolify & VPS Pure Node.js + SQLite WAL Ready ZIP Package Download
  app.get('/api/download-coolify-zip', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    try {
      ensureUploadsDirectories();
      if (migrateBase64ImagesInState(db)) {
        saveDbToDisk();
      }

      const entries: ZipEntryInput[] = [];
      const ignoreDirs = new Set([
        'node_modules',
        '.git',
        '.aistudio',
        'backend',
        'api'
      ]);
      collectDirRecursive(__dirname, '', entries, ignoreDirs);

      const coolifyGuide = `====================================================================
StockMaster BD - ১-ক্লিকে Coolify ও VPS ডিপ্লয়মেন্ট গাইড (Pure Node.js + SQLite WAL)
====================================================================

ধাপ ১: এই ফাইলগুলো আপনার GitHub Repository-তে আপলোড করুন অথবা সরাসরি VPS-এ আনজিপ করুন।
ধাপ ২: আপনার Coolify ড্যাশবোর্ডে গিয়ে "+ Add New Resource" -> GitHub Repo সিলেক্ট করুন।
ধাপ ৩: Build Pack হিসেবে "Dockerfile" অথবা "Docker Compose" সিলেক্ট করুন।
ধাপ ৪: Persistent Storage (যাতে রিবিল্ড দিলেও ডাটাবেস ও ছবি কখনো না মুছে যায়):
   - Volume 1 Destination Path: /app/data
   - Volume 2 Destination Path: /app/uploads
ধাপ ৫: আপনার ডোমেইন বসিয়ে "Deploy" বাটনে ক্লিক করুন! (Port: 3000)

ডিফল্ট অ্যাডমিন লগইন:
অ্যাডমিন প্যানেল লিংক: https://আপনার-ডোমেইন.com/smart
ইমেইল/ইউজারনেম: owner@stockflowbd.com (অথবা admin)
পাসওয়ার্ড: Admin@1234
====================================================================\n`;
      entries.push({
        zipPath: 'COOLIFY_VPS_GUIDE_BANGLA.txt',
        data: Buffer.from(coolifyGuide, 'utf-8'),
      });

      const zipBuf = createZipBuffer(entries);
      const filename = 'stockmaster_coolify_vps_ready_nodejs.zip';

      if (req.query.format === 'base64') {
        return res.json({
          success: true,
          filename,
          fileCount: entries.length,
          byteSize: zipBuf.length,
          base64: zipBuf.toString('base64'),
        });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(zipBuf.length));
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(zipBuf);
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: 'Failed to generate Coolify VPS ZIP: ' + (err?.message || 'Unknown error'),
      });
    }
  });

  // 1-Click Portable JSON Database Backup (Compatible with VPS, PostgreSQL, and cPanel)
  app.get('/api/vps-backup-json', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    try {
      const dateTag = new Date().toISOString().split('T')[0];
      const filename = `stockmaster_full_backup_${dateTag}.json`;
      const payload = JSON.stringify(db, null, 2);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(payload);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'Backup failed' });
    }
  });

  // 1-Click Binary SQLite (WAL) Database Download
  app.get('/api/vps-backup-sqlite', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    try {
      saveDbToDisk();
      const buf = getSqliteDatabaseBuffer();
      if (!buf) {
        return res.status(404).json({ success: false, error: 'SQLite database file not available' });
      }
      const dateTag = new Date().toISOString().split('T')[0];
      const filename = `stockmaster_vps_${dateTag}.sqlite`;
      res.setHeader('Content-Type', 'application/x-sqlite3');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(buf);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || 'SQLite backup failed' });
    }
  });

  // 1-Click Database Restore from Portable JSON Backup
  app.post('/api/vps-restore-json', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    try {
      const incoming = req.body?.backupData || req.body;
      if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.products)) {
        return res.status(400).json({
          success: false,
          error: 'সঠিক ব্যাকআপ ফাইল নয়! (Invalid StockMaster backup JSON)',
        });
      }
      const existingUsers = Array.isArray(db.users) ? [...db.users] : [...initialUsers];
      Object.assign(db, incoming);
      db.updatedAt = Date.now();
      db.cacheVersion = `cv_restore_${Date.now()}`;
      db.users = mergeAndHashUsersTs(
        existingUsers,
        Array.isArray(incoming.users) ? incoming.users : []
      );
      migrateBase64ImagesInState(db);
      saveDbToDisk();

      return res.json({
        success: true,
        message: 'ডাটাবেস ব্যাকআপ সফলভাবে রিস্টোর ও সিঙ্ক হয়েছে!',
        totalProducts: Array.isArray(db.products) ? db.products.length : 0,
        totalOrders: Array.isArray(db.onlineOrders) ? db.onlineOrders.length : 0,
        totalCustomers: Array.isArray(db.customers) ? db.customers.length : 0,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to restore backup',
      });
    }
  });

  const getVisitorIpTs = (req: Request): string => {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
    return String(req.socket?.remoteAddress || req.ip || '127.0.0.1').trim();
  };

  const normalizeBdPhone11Ts = (raw: any): string => {
    const bnMap: Record<string, string> = {
      '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
      '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
    };
    let digits = String(raw || '')
      .replace(/[০-৯]/g, d => bnMap[d] || d)
      .replace(/\D/g, '');
    if (digits.startsWith('008801') && digits.length >= 15) {
      digits = digits.slice(4);
    } else if (digits.startsWith('8801') && digits.length >= 13) {
      digits = digits.slice(2);
    }
    if (digits.length === 10 && /^1[3-9]\d{8}$/.test(digits)) {
      digits = '0' + digits;
    }
    if (digits.length > 11 && digits.startsWith('01')) {
      digits = digits.slice(0, 11);
    }
    return /^01[3-9]\d{8}$/.test(digits) ? digits : '';
  };

  const hmacOrderLockValueTs = (type: 'phone' | 'ip', raw: any): string => {
    const val = String(raw || '').trim();
    if (!val) return '';
    if (type === 'phone') {
      const norm = normalizeBdPhone11Ts(val);
      if (!norm) return '';
      return crypto
        .createHmac('sha256', ADMIN_SESSION_SECRET)
        .update(`order_lock_phone:${norm}`)
        .digest('hex');
    }
    if (type === 'ip') {
      const lowerIp = val.toLowerCase();
      if (lowerIp === '127.0.0.1' || lowerIp === '::1' || lowerIp === 'localhost') {
        return '';
      }
      return crypto
        .createHmac('sha256', ADMIN_SESSION_SECRET)
        .update(`order_lock_ip:${lowerIp}`)
        .digest('hex');
    }
    return '';
  };

  const buildTodayOrderLocksTs = (ordersList: any[], visitorIp = ''): any[] => {
    if (!Array.isArray(ordersList) || ordersList.length === 0) return [];
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const visitorIpHmac = hmacOrderLockValueTs('ip', visitorIp);
    const locks: any[] = [];
    for (const o of ordersList) {
      if (!o || typeof o !== 'object') continue;
      if (o.orderStatus === 'cancelled') continue;
      const ts = Date.parse(String(o.createdAt || '')) || 0;
      if (ts < cutoffMs) continue;
      const prodIds: string[] = [];
      if (Array.isArray(o.items)) {
        for (const it of o.items) {
          const pid = String(it?.productId || '').trim();
          if (pid && !prodIds.includes(pid)) {
            prodIds.push(pid);
          }
        }
      }
      const phoneHmac =
        typeof o.phoneHmac === 'string' && o.phoneHmac
          ? o.phoneHmac
          : hmacOrderLockValueTs('phone', o.customerPhone || o.phone || '');
      const ipHmac =
        typeof o.ipHmac === 'string' && o.ipHmac
          ? o.ipHmac
          : hmacOrderLockValueTs('ip', o.clientIp || '');
      locks.push({
        id: String(o.id || o.orderNo || ''),
        phoneHmac,
        ipHmac,
        ipMatched: Boolean(visitorIpHmac && ipHmac && visitorIpHmac === ipHmac),
        clientDeviceId: String(o.clientDeviceId || ''),
        createdAt: String(o.createdAt || ''),
        orderStatus: String(o.orderStatus || 'pending'),
        productIds: prodIds
      });
    }
    return locks.slice(0, 300);
  };

  const evaluateDailyOrderLimitTs = (
    ordersList: any[],
    businessConfig: any,
    phone: string,
    visitorIp: string,
    clientDeviceId: string,
    targetProductIds: string[] = [],
    excludeOrderIds: string[] = []
  ) => {
    const biz = businessConfig && typeof businessConfig === 'object' ? businessConfig : {};
    const isEnabled = biz.dailyOrderLimitEnabled !== false;
    const sameProductMaxCount = Math.max(1, Number(biz.dailySameProductMaxCount ?? 2));
    const rawTotalMax = biz.dailyOrderMaxCount;
    const maxCount = Math.max(
      1,
      Number(
        biz.dailySameProductMaxCount === undefined && (rawTotalMax === undefined || rawTotalMax === 2)
          ? 5
          : (rawTotalMax ?? 5)
      )
    );
    const title =
      String(biz.dailyOrderLimitTitle || '').trim() || 'আজকের অর্ডার লিমিট পূর্ণ হয়েছে!';
    const message =
      String(biz.dailyOrderLimitMessage || '').trim() ||
      'দুঃখিত! ফেইক অর্ডার প্রতিরোধে আমাদের সিস্টেমে একই মোবাইল নাম্বার বা ডিভাইস থেকে দিনে একই প্রোডাক্ট সর্বোচ্চ ২ বার এবং ভিন্ন প্রোডাক্টসহ মোট সর্বোচ্চ ৫ বার অর্ডার করা যায়। জরুরি প্রয়োজনে আমাদের হেল্পলাইনে যোগাযোগ করুন।';

    const targetPhoneHmac = hmacOrderLockValueTs('phone', phone);
    const visitorIpHmac = hmacOrderLockValueTs('ip', visitorIp);

    if (!isEnabled) {
      return {
        blocked: false,
        count: 0,
        maxCount,
        sameProductCount: 0,
        sameProductMaxCount,
        title,
        message,
        phoneHmac: targetPhoneHmac,
        visitorIpHmac
      };
    }

    const cleanTargetProdIds = Array.from(
      new Set(
        (Array.isArray(targetProductIds) ? targetProductIds : [])
          .map(id => String(id || '').trim())
          .filter(Boolean)
      )
    );
    const excludeSet = new Set(
      (Array.isArray(excludeOrderIds) ? excludeOrderIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    );

    const nowDate = new Date();
    const startOfTodayMs = new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate()
    ).getTime();
    const resetAtMs = Number(biz.dailyOrderLimitResetAt || 0);
    const effectiveCutoffMs = Math.max(startOfTodayMs, resetAtMs);

    const phoneOrderIds = new Set<string>();
    const deviceOrIpOrderIds = new Set<string>();
    const phoneProductOrdersMap = new Map<string, Set<string>>();
    const deviceProductOrdersMap = new Map<string, Set<string>>();

    const addProdRef = (map: Map<string, Set<string>>, pid: string, oid: string) => {
      if (!pid || !oid) return;
      let s = map.get(pid);
      if (!s) {
        s = new Set<string>();
        map.set(pid, s);
      }
      s.add(oid);
    };

    const cleanDevId = String(clientDeviceId || '').trim();

    for (const o of Array.isArray(ordersList) ? ordersList : []) {
      if (!o || typeof o !== 'object' || o.orderStatus === 'cancelled') continue;
      const oid = String(o.id || o.orderNo || '').trim();
      const ono = String(o.orderNo || '').trim();
      if (!oid) continue;
      if (excludeSet.has(oid) || (ono && excludeSet.has(ono))) continue;
      const ts = Date.parse(String(o.createdAt || '')) || 0;
      if (ts < effectiveCutoffMs) continue;

      const recProdIds = Array.isArray(o.productIds)
        ? o.productIds.map((p: any) => String(p || '').trim()).filter(Boolean)
        : Array.isArray(o.items)
        ? Array.from(
            new Set(o.items.map((it: any) => String(it?.productId || '').trim()).filter(Boolean))
          )
        : [];

      const ordPhoneHmac =
        typeof o.phoneHmac === 'string' && o.phoneHmac
          ? o.phoneHmac
          : hmacOrderLockValueTs('phone', o.customerPhone || o.phone || '');
      const isPhoneMatch = Boolean(targetPhoneHmac && ordPhoneHmac && targetPhoneHmac === ordPhoneHmac);
      if (isPhoneMatch) {
        phoneOrderIds.add(oid);
        for (const pid of recProdIds) {
          addProdRef(phoneProductOrdersMap, pid, oid);
        }
      }

      const ordDev = String(o.clientDeviceId || '').trim();
      const ordIpHmac =
        typeof o.ipHmac === 'string' && o.ipHmac
          ? o.ipHmac
          : hmacOrderLockValueTs('ip', o.clientIp || '');
      const isDevOrIpMatch =
        Boolean(cleanDevId && ordDev && cleanDevId === ordDev) ||
        Boolean(visitorIpHmac && ordIpHmac && visitorIpHmac === ordIpHmac);
      if (isDevOrIpMatch) {
        deviceOrIpOrderIds.add(oid);
        for (const pid of recProdIds) {
          addProdRef(deviceProductOrdersMap, pid, oid);
        }
      }
    }

    const phoneCount = phoneOrderIds.size;
    const deviceCount = deviceOrIpOrderIds.size;
    const highestCount = Math.max(phoneCount, deviceCount);

    let highestSameProductCount = 0;
    for (const pid of cleanTargetProdIds) {
      const pSameCount = phoneProductOrdersMap.get(pid)?.size || 0;
      const dSameCount = deviceProductOrdersMap.get(pid)?.size || 0;
      const curMaxSame = Math.max(pSameCount, dSameCount);
      if (curMaxSame > highestSameProductCount) {
        highestSameProductCount = curMaxSame;
      }
      if (pSameCount >= sameProductMaxCount) {
        return {
          blocked: true,
          count: Math.max(phoneCount, pSameCount),
          maxCount,
          sameProductCount: pSameCount,
          sameProductMaxCount,
          blockType: 'same_product',
          title,
          message,
          reason: 'phone',
          phoneHmac: targetPhoneHmac,
          visitorIpHmac
        };
      }
      if (dSameCount >= sameProductMaxCount) {
        return {
          blocked: true,
          count: Math.max(deviceCount, dSameCount),
          maxCount,
          sameProductCount: dSameCount,
          sameProductMaxCount,
          blockType: 'same_product',
          title,
          message,
          reason: 'ip_or_device',
          phoneHmac: targetPhoneHmac,
          visitorIpHmac
        };
      }
    }

    if (phoneCount >= maxCount) {
      return {
        blocked: true,
        count: phoneCount,
        maxCount,
        sameProductCount: highestSameProductCount,
        sameProductMaxCount,
        blockType: 'total_daily',
        title,
        message,
        reason: 'phone',
        phoneHmac: targetPhoneHmac,
        visitorIpHmac
      };
    }

    if (deviceCount >= maxCount) {
      return {
        blocked: true,
        count: deviceCount,
        maxCount,
        sameProductCount: highestSameProductCount,
        sameProductMaxCount,
        blockType: 'total_daily',
        title,
        message,
        reason: 'ip_or_device',
        phoneHmac: targetPhoneHmac,
        visitorIpHmac
      };
    }

    return {
      blocked: false,
      count: highestCount,
      maxCount,
      sameProductCount: highestSameProductCount,
      sameProductMaxCount,
      title,
      message,
      phoneHmac: targetPhoneHmac,
      visitorIpHmac
    };
  };

  // Full ERP State Synchronization Endpoints (Persistent Disk Storage + cPanel /api/index.php compatibility)
  const handleGetState = (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const isExplicitPublic = String(req.query?.mode || '').trim().toLowerCase() === 'public';
    const hasAdminAuth = verifyAdminDownloadAuthTs(req);
    const shouldServePublic = isExplicitPublic || !hasAdminAuth;
    const visitorIp = getVisitorIpTs(req);
    const todayOrderLocks = buildTodayOrderLocksTs(
      Array.isArray(db?.onlineOrders) ? db.onlineOrders : [],
      visitorIp
    );

    if (shouldServePublic && db && typeof db === 'object') {
      const publicBusinesses = Array.isArray(db.businesses)
        ? db.businesses.map((b: any) => {
            if (!b || typeof b !== 'object') return b;
            const hasActiveSmsCreds =
              b.smsProvider === 'greenweb'
                ? Boolean(String(b.greenwebToken || '').trim())
                : Boolean(String(b.smsApiKey || '').trim());
            const hasActiveFbCapiCreds = Boolean(
              String(b.fbAccessToken || b.fbCapiAccessToken || '').trim()
            );
            const {
              smsApiKey,
              greenwebToken,
              steadfastApiKey,
              steadfastSecretKey,
              steadfastAuthPassword,
              steadfastWebhookToken,
              pathaoClientSecret,
              pathaoPassword,
              pathaoWebhookToken,
              redxAccessToken,
              carrybeeClientSecret,
              bdcourierApiKey,
              fbAccessToken,
              fbCapiAccessToken,
              wpConsumerKey,
              wpConsumerSecret,
              spinWheelLeads,
              landingSpinWheelLeads,
              deletedSpinLeadIds,
              ...safeBiz
            } = b;
            return {
              ...safeBiz,
              smsConfigured: hasActiveSmsCreds,
              fbCapiConfigured: hasActiveFbCapiCreds
            };
          })
        : [];
      return res.json({
        success: true,
        storage: 'disk',
        data: {
          _isPublicPayload: true,
          updatedAt: db.updatedAt || 0,
          visitorIpHmac: hmacOrderLockValueTs('ip', visitorIp),
          todayOrderLocks,
          ...(db.cacheVersion ? { cacheVersion: db.cacheVersion } : {}),
          ...(db.dbInstanceId ? { dbInstanceId: db.dbInstanceId } : {}),
          businesses: publicBusinesses,
          outlets: Array.isArray(db.outlets) ? db.outlets : [],
          categories: Array.isArray(db.categories) ? db.categories : [],
          brands: Array.isArray(db.brands) ? db.brands : [],
          products: Array.isArray(db.products) ? db.products : [],
          deletedProductIds: Array.isArray(db.deletedProductIds) ? db.deletedProductIds : []
        }
      });
    }
    res.json({
      success: true,
      storage: 'disk',
      data: {
        ...db,
        users: stripUserPasswordsForClientTs(Array.isArray(db.users) ? db.users : []),
        visitorIpHmac: hmacOrderLockValueTs('ip', visitorIp),
        todayOrderLocks
      }
    });
  };

  const sanitizeCustomerTextTs = (val: any, maxLen = 500): string => {
    if (typeof val !== 'string' && typeof val !== 'number') return '';
    let str = String(val).trim();
    if (!str) return '';
    str = str.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    str = str.replace(/<[^>]+>/g, '');
    str = str.replace(/javascript\s*:/gi, '');
    str = str.replace(/\bon[a-z]+\s*=/gi, '');
    str = str.replace(/\0/g, '');
    return str.trim().slice(0, maxLen);
  };

  const handlePostState = (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const incoming = req.body;
    if (incoming && typeof incoming === 'object') {
      const isAdminMutation = incoming._isAdminMutation === true && verifyAdminDownloadAuthTs(req);
      const existingIncomplete: any[] = Array.isArray(db.incompleteOrders) ? db.incompleteOrders : [];
      const existingOnlineOrders: any[] = Array.isArray(db.onlineOrders) ? db.onlineOrders : [];
      const existingCustomers: any[] = Array.isArray(db.customers) ? db.customers : [];
      const existingDeletedIds: string[] = Array.isArray(db.deletedIncompleteOrderIds)
        ? db.deletedIncompleteOrderIds
        : [];
      const incomingDeletedIds: string[] =
        isAdminMutation && Array.isArray(incoming.deletedIncompleteOrderIds)
          ? incoming.deletedIncompleteOrderIds
          : [];
      const mergedDeletedIds = Array.from(new Set([...existingDeletedIds, ...incomingDeletedIds])).slice(-500);
      const deletedSet = new Set(mergedDeletedIds);

      const existingProducts: any[] = Array.isArray(db.products) ? [...db.products] : [];
      const existingDeletedProductIds: string[] = Array.isArray(db.deletedProductIds)
        ? db.deletedProductIds
        : [];
      const incomingDeletedProductIds: string[] =
        isAdminMutation && Array.isArray(incoming.deletedProductIds)
          ? incoming.deletedProductIds
          : [];
      const mergedDeletedProductIds = Array.from(
        new Set([...existingDeletedProductIds, ...incomingDeletedProductIds])
      ).slice(-500);
      const deletedProdSet = new Set(mergedDeletedProductIds.map(String));

      const existingBusinesses = Array.isArray(db.businesses) ? [...db.businesses] : [];
      const existingUsers = Array.isArray(db.users) ? [...db.users] : [];
      const adminOnlyKeys = new Set([
        'users',
        'outlets',
        'categories',
        'brands',
        'suppliers',
        'purchases',
        'purchaseReturns',
        'saleReturns',
        'expenses',
        'accounts',
        'stockTransfers',
        'stockAdjustments',
        'dayEndClosures',
        'heldCarts'
      ]);
      const allowedKeys = [
        'updatedAt',
        'dbInstanceId',
        'businesses',
        'outlets',
        'categories',
        'brands',
        'products',
        'sales',
        'onlineOrders',
        'incompleteOrders',
        'deletedProductIds',
        'saleReturns',
        'purchases',
        'purchaseReturns',
        'customers',
        'customerLedger',
        'suppliers',
        'expenses',
        'accounts',
        'stockTransfers',
        'stockAdjustments',
        'stockMovements',
        'auditLogs',
        'dayEndClosures',
        'users',
        'heldCarts'
      ];
      for (const key of allowedKeys) {
        if (key === 'users') continue;
        if (incoming[key] !== undefined) {
          if (!isAdminMutation && adminOnlyKeys.has(key) && Array.isArray(db[key]) && db[key].length > 0) {
            continue;
          }
          db[key] = incoming[key];
        }
      }

      if (isAdminMutation && Array.isArray(incoming.users)) {
        db.users = mergeAndHashUsersTs(existingUsers, incoming.users);
      } else {
        db.users = mergeAndHashUsersTs(existingUsers, []);
      }

      db.deletedProductIds = mergedDeletedProductIds;

      // Authoritative Product & Landing Page sync:
      // Admin mutations can add/update/delete products; visitor mutations only update stock/reviews on existing products
      if (Array.isArray(incoming.products) || existingProducts.length > 0) {
        const incProds: any[] = Array.isArray(incoming.products) ? incoming.products : [];
        const prodMap = new Map<string, any>();
        const prodOrder: string[] = [];

        if (isAdminMutation && incProds.length > 0) {
          const existingById = new Map<string, any>();
          for (const ep of existingProducts) {
            if (ep && ep.id) existingById.set(String(ep.id), ep);
          }
          for (const p of incProds) {
            if (!p || !p.id) continue;
            const pid = String(p.id);
            if (deletedProdSet.has(pid)) continue;
            const prev = existingById.get(pid);
            if (!prev) {
              prodMap.set(pid, p);
              prodOrder.push(pid);
            } else {
              const revMap = new Map<string, any>();
              const oldRevs = Array.isArray(prev.landingReviewItems) ? prev.landingReviewItems : [];
              const newRevs = Array.isArray(p.landingReviewItems) ? p.landingReviewItems : [];
              for (const r of [...oldRevs, ...newRevs]) {
                if (!r || !r.id) continue;
                const prevRev = revMap.get(String(r.id));
                if (!prevRev) {
                  revMap.set(String(r.id), r);
                } else {
                  revMap.set(String(r.id), {
                    ...prevRev,
                    ...r,
                    status: prevRev.status === 'approved' || r.status === 'approved' ? 'approved' : r.status || prevRev.status
                  });
                }
              }
              prodMap.set(pid, {
                ...prev,
                ...p,
                ...(revMap.size > 0 ? { landingReviewItems: Array.from(revMap.values()) } : {})
              });
              prodOrder.push(pid);
            }
          }
        } else {
          for (const p of existingProducts) {
            if (!p || !p.id) continue;
            const pid = String(p.id);
            if (deletedProdSet.has(pid)) continue;
            prodMap.set(pid, p);
            prodOrder.push(pid);
          }

          for (const p of incProds) {
            if (!p || !p.id) continue;
            const pid = String(p.id);
            if (deletedProdSet.has(pid)) continue;
            const prev = prodMap.get(pid);
            if (!prev) {
              if (existingProducts.length === 0) {
                prodMap.set(pid, p);
                prodOrder.push(pid);
              }
            } else {
              const revMap = new Map<string, any>();
              const oldRevs = Array.isArray(prev.landingReviewItems) ? prev.landingReviewItems : [];
              const newRevs = Array.isArray(p.landingReviewItems) ? p.landingReviewItems : [];
              for (const r of [...oldRevs, ...newRevs]) {
                if (!r || !r.id) continue;
                const prevRev = revMap.get(String(r.id));
                if (!prevRev) {
                  revMap.set(String(r.id), r);
                } else {
                  revMap.set(String(r.id), {
                    ...prevRev,
                    ...r,
                    status: prevRev.status === 'approved' || r.status === 'approved' ? 'approved' : r.status || prevRev.status
                  });
                }
              }

              prodMap.set(pid, {
                ...prev,
                stockByOutlet: p.stockByOutlet || prev.stockByOutlet,
                ...(revMap.size > 0 ? { landingReviewItems: Array.from(revMap.values()) } : {})
              });
            }
          }
        }

        db.products = prodOrder.map(id => prodMap.get(id)).filter(Boolean);
      }

      // Smart-merge Spin Wheel Leads inside businesses[0] so visitor spins on another device are never overwritten
      if (Array.isArray(db.businesses) && db.businesses.length > 0 && existingBusinesses.length > 0) {
        const prevBiz = existingBusinesses[0] || {};
        const nextBiz = db.businesses[0] || {};
        const mergedDeletedSpinIds = Array.from(
          new Set([
            ...(Array.isArray(prevBiz.deletedSpinLeadIds) ? prevBiz.deletedSpinLeadIds : []),
            ...(isAdminMutation && Array.isArray(nextBiz.deletedSpinLeadIds) ? nextBiz.deletedSpinLeadIds : [])
          ])
        ).slice(-500);
        const deletedSpinSet = new Set(mergedDeletedSpinIds.map(String));

        const mergeLeads = (prevArr: any[], incArr: any[]) => {
          const map = new Map<string, any>();
          for (const item of prevArr) {
            if (item && item.id && !deletedSpinSet.has(String(item.id))) {
              map.set(String(item.id), item);
            }
          }
          for (const item of incArr) {
            if (item && item.id && !deletedSpinSet.has(String(item.id))) {
              const sanitizedItem = {
                ...item,
                ...(item.customerName !== undefined ? { customerName: sanitizeCustomerTextTs(item.customerName, 120) } : {}),
                ...(item.couponCode !== undefined ? { couponCode: sanitizeCustomerTextTs(item.couponCode, 60) } : {})
              };
              const old = map.get(String(item.id));
              if (!old) {
                map.set(String(item.id), sanitizedItem);
              } else {
                map.set(String(item.id), {
                  ...old,
                  ...sanitizedItem,
                  usedInOrder: Boolean(old.usedInOrder || sanitizedItem.usedInOrder),
                  orderInvoiceNo: sanitizedItem.orderInvoiceNo || old.orderInvoiceNo
                });
              }
            }
          }
          return Array.from(map.values())
            .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
            .slice(0, 500);
        };

        const preservedSecrets: Record<string, any> = {};
        if (isAdminMutation) {
          for (const sk of [
            'smsApiKey',
            'greenwebToken',
            'steadfastApiKey',
            'steadfastSecretKey',
            'steadfastAuthPassword',
            'steadfastWebhookToken',
            'pathaoClientSecret',
            'pathaoPassword',
            'pathaoWebhookToken',
            'redxAccessToken',
            'carrybeeClientSecret',
            'bdcourierApiKey',
            'fbAccessToken',
            'fbCapiAccessToken',
            'wpConsumerKey',
            'wpConsumerSecret'
          ]) {
            if (nextBiz[sk] === undefined && prevBiz[sk] !== undefined) {
              preservedSecrets[sk] = prevBiz[sk];
            }
          }
        }

        db.businesses[0] = {
          ...(isAdminMutation ? { ...prevBiz, ...nextBiz, ...preservedSecrets } : prevBiz),
          spinWheelLeads: mergeLeads(
            Array.isArray(prevBiz.spinWheelLeads) ? prevBiz.spinWheelLeads : [],
            Array.isArray(nextBiz.spinWheelLeads) ? nextBiz.spinWheelLeads : []
          ),
          landingSpinWheelLeads: mergeLeads(
            Array.isArray(prevBiz.landingSpinWheelLeads) ? prevBiz.landingSpinWheelLeads : [],
            Array.isArray(nextBiz.landingSpinWheelLeads) ? nextBiz.landingSpinWheelLeads : []
          ),
          deletedSpinLeadIds: mergedDeletedSpinIds
        };
      }

      const normalizeServerBdPhone = (raw: any): string => {
        const bnMap: Record<string, string> = {
          '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
          '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9'
        };
        let digits = String(raw || '')
          .replace(/[০-৯]/g, d => bnMap[d] || d)
          .replace(/\D/g, '');
        if (digits.startsWith('008801') && digits.length >= 15) {
          digits = digits.slice(4);
        } else if (digits.startsWith('8801') && digits.length >= 13) {
          digits = digits.slice(2);
        }
        if (digits.length === 10 && /^1[3-9]\d{8}$/.test(digits)) {
          digits = '0' + digits;
        }
        if (digits.length > 11 && digits.startsWith('01')) {
          digits = digits.slice(0, 11);
        }
        return digits;
      };
      const isValidServerBdPhone11 = (raw: any): boolean =>
        /^01[3-9]\d{8}$/.test(normalizeServerBdPhone(raw));
      const statusRank: Record<string, number> = {
        abandoned: 1,
        contacted: 2,
        ignored: 3,
        converted: 4
      };

      // Smart Multi-Device Merge for incompleteOrders (strictly 11-digit phone, deduplicated by phone & sessionKey)
      const incomingIncomplete: any[] = Array.isArray(incoming.incompleteOrders) ? incoming.incompleteOrders : [];
      const incByPhoneOrSession = new Map<string, any>();
      const incListSource = isAdminMutation ? incomingIncomplete : [...existingIncomplete, ...incomingIncomplete];
      for (const item of incListSource) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id || '').trim();
        if (!id || deletedSet.has(id)) continue;
        const normPhone = normalizeServerBdPhone(item.customerPhone);
        if (!isValidServerBdPhone11(normPhone)) continue;

        const normalizedItem = {
          ...item,
          customerPhone: normPhone,
          ...(item.customerName !== undefined ? { customerName: sanitizeCustomerTextTs(item.customerName, 160) } : {}),
          ...(item.deliveryAddress !== undefined ? { deliveryAddress: sanitizeCustomerTextTs(item.deliveryAddress, 400) } : {}),
          ...(item.notes !== undefined ? { notes: sanitizeCustomerTextTs(item.notes, 400) } : {})
        };
        const key = `phone_${normPhone}`;
        const prev = incByPhoneOrSession.get(key);
        if (!prev) {
          incByPhoneOrSession.set(key, normalizedItem);
        } else {
          const prevTime = Date.parse(String(prev.updatedAt || prev.createdAt || '')) || 0;
          const nextTime = Date.parse(String(normalizedItem.updatedAt || normalizedItem.createdAt || '')) || 0;
          const prevRank = statusRank[String(prev.status || 'abandoned')] || 1;
          const nextRank = statusRank[String(normalizedItem.status || 'abandoned')] || 1;
          const merged = nextTime >= prevTime ? { ...prev, ...normalizedItem } : { ...normalizedItem, ...prev };
          const bestStatus =
            nextRank > prevRank
              ? normalizedItem.status
              : prevRank > nextRank && Math.abs(nextTime - prevTime) < 60000
              ? prev.status
              : merged.status;
          incByPhoneOrSession.set(key, {
            ...merged,
            customerPhone: normPhone,
            status: bestStatus,
            convertedOrderId: normalizedItem.convertedOrderId || prev.convertedOrderId,
            convertedOrderNo: normalizedItem.convertedOrderNo || prev.convertedOrderNo
          });
        }
      }
      db.incompleteOrders = Array.from(incByPhoneOrSession.values())
        .filter(it => !deletedSet.has(String(it.id || '')))
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
        .slice(0, 300);
      db.deletedIncompleteOrderIds = mergedDeletedIds;

      // Smart Multi-Device Merge for onlineOrders (with Backend Daily Order Limit enforcement for new visitor orders)
      const visitorPostIp = getVisitorIpTs(req);
      const activeBizCfg = Array.isArray(db.businesses) && db.businesses[0] ? db.businesses[0] : {};
      const existingOrdIds = new Set<string>();
      for (const eo of existingOnlineOrders) {
        if (!eo || typeof eo !== 'object') continue;
        const eId = String(eo.id || '').trim();
        const eNo = String(eo.orderNo || '').trim();
        if (eId) existingOrdIds.add(eId);
        if (eNo) existingOrdIds.add(eNo);
      }
      const incomingOrders: any[] = Array.isArray(incoming.onlineOrders) ? incoming.onlineOrders : [];
      if (existingOnlineOrders.length > 0 || incomingOrders.length > 0) {
        const ordMap = new Map<string, any>();
        for (const eo of existingOnlineOrders) {
          if (!eo || typeof eo !== 'object') continue;
          const k = String(eo.id || eo.orderNo || '').trim();
          if (k) ordMap.set(k, eo);
        }
        for (const ord of incomingOrders) {
          if (!ord || typeof ord !== 'object') continue;
          const oId = String(ord.id || '').trim();
          const oNo = String(ord.orderNo || '').trim();
          const key = oId || oNo;
          if (!key) continue;
          const normPhone = normalizeServerBdPhone(ord.customerPhone);
          const isNewOrder = !existingOrdIds.has(key) && (!oNo || !existingOrdIds.has(oNo));
          const normalizedOrd = {
            ...ord,
            ...(isValidServerBdPhone11(normPhone) ? { customerPhone: normPhone } : {}),
            ...(ord.customerName !== undefined ? { customerName: sanitizeCustomerTextTs(ord.customerName, 160) } : {}),
            ...(ord.deliveryAddress !== undefined ? { deliveryAddress: sanitizeCustomerTextTs(ord.deliveryAddress, 400) } : {}),
            ...(ord.notes !== undefined ? { notes: sanitizeCustomerTextTs(ord.notes, 400) } : {}),
            ...(isNewOrder && !ord.clientIp ? { clientIp: visitorPostIp } : {})
          };
          const prev = ordMap.get(key);
          if (!prev) {
            if (!isAdminMutation && isNewOrder && normalizedOrd.orderSource !== 'incomplete_recovery') {
              const ordProdIds = Array.isArray(normalizedOrd.items)
                ? normalizedOrd.items
                    .map((it: any) => String(it?.productId || '').trim())
                    .filter(Boolean)
                : [];
              const limitEval = evaluateDailyOrderLimitTs(
                Array.from(ordMap.values()),
                activeBizCfg,
                String(normalizedOrd.customerPhone || ''),
                String(normalizedOrd.clientIp || visitorPostIp),
                String(normalizedOrd.clientDeviceId || ''),
                ordProdIds,
                [key, oId, oNo]
              );
              if (limitEval.blocked) {
                continue;
              }
            }
            ordMap.set(key, normalizedOrd);
          } else if (!isAdminMutation) {
            ordMap.set(key, prev);
          } else {
            const prevTime = Date.parse(String(prev.updatedAt || prev.createdAt || '')) || 0;
            const nextTime = Date.parse(String(normalizedOrd.updatedAt || normalizedOrd.createdAt || '')) || 0;
            ordMap.set(key, nextTime >= prevTime ? { ...prev, ...normalizedOrd } : { ...normalizedOrd, ...prev });
          }
        }
        db.onlineOrders = Array.from(ordMap.values()).sort((a, b) =>
          String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        );
      }

      // Smart Multi-Device Merge for customers (normalize to 11-digit BD phone and drop partial <11-digit auto-leads)
      const incomingCusts: any[] = Array.isArray(incoming.customers) ? incoming.customers : [];
      if (existingCustomers.length > 0 || incomingCusts.length > 0) {
        const custMap = new Map<string, any>();
        const custListSource = isAdminMutation ? incomingCusts : [...existingCustomers, ...incomingCusts];
        for (const cust of custListSource) {
          if (!cust || typeof cust !== 'object') continue;
          const normPhone = normalizeServerBdPhone(cust.phone);
          const isValid11 = isValidServerBdPhone11(normPhone);
          const custId = String(cust.id || '').trim();
          if (!isValid11 && (custId.startsWith('cust_lead_') || custId.startsWith('cust_onl_'))) {
            continue;
          }
          const key = isValid11 ? normPhone : custId;
          if (!key) continue;
          const normalizedCust = {
            ...cust,
            ...(isValid11 ? { phone: normPhone } : {}),
            ...(cust.name !== undefined ? { name: sanitizeCustomerTextTs(cust.name, 160) } : {}),
            ...(cust.address !== undefined ? { address: sanitizeCustomerTextTs(cust.address, 400) } : {})
          };
          const prev = custMap.get(key);
          if (!prev) {
            custMap.set(key, normalizedCust);
          } else {
            custMap.set(key, {
              ...prev,
              ...normalizedCust,
              phone: isValid11 ? normPhone : normalizedCust.phone || prev.phone,
              name:
                normalizedCust.name &&
                normalizedCust.name !== 'চেকআউট ভিজিটর (Lead)' &&
                normalizedCust.name !== 'অনলাইন ক্রেতা'
                  ? normalizedCust.name
                  : prev.name || normalizedCust.name,
              address:
                normalizedCust.address && normalizedCust.address !== 'অসম্পূর্ণ চেকআউট'
                  ? normalizedCust.address
                  : prev.address || normalizedCust.address,
              password: normalizedCust.password || prev.password || ''
            });
          }
        }
        db.customers = Array.from(custMap.values());
      }

      // Automatically convert any Base64 images in products/businesses into physical /uploads/ files before saving state
      migrateBase64ImagesInState(db);

      db.updatedAt = Math.max(Number(db.updatedAt || 0) + 1, Number(incoming.updatedAt) || Date.now());
      saveDbToDisk();
    }
    res.json({ success: true, updatedAt: db.updatedAt });
  };

  const handleUploadImage = (req: Request, res: Response) => {
    if (!verifyAdminDownloadAuthTs(req)) {
      return res.status(401).json({
        success: false,
        error: 'অনুমোদিত নয়! ছবি আপলোড করার জন্য বৈধ অ্যাডমিন সেশন টোকেন প্রয়োজন। (401 Unauthorized)'
      });
    }
    try {
      const dataUrl = String(req.body?.dataUrl || '').trim();
      const thumbDataUrl =
        typeof req.body?.thumbDataUrl === 'string' ? req.body.thumbDataUrl.trim() : undefined;
      const folder = req.body?.folder === 'logos' ? 'logos' : 'products';
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        return res.status(400).json({
          success: false,
          error: 'Valid data:image/* payload is required'
        });
      }
      const savedUrl = saveBase64ImageToDisk(dataUrl, folder, thumbDataUrl);
      if (!savedUrl) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or unsupported image format'
        });
      }
      return res.json({
        success: true,
        url: savedUrl
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Image upload failed'
      });
    }
  };

  const handleClearCache = (req: Request, res: Response) => {
    if (!verifyAdminDownloadAuthTs(req)) {
      return res.status(401).json({
        success: false,
        error: 'অনুমোদিত নয়! ক্যাশ ক্লিয়ার করার জন্য বৈধ অ্যাডমিন সেশন টোকেন প্রয়োজন। (401 Unauthorized)'
      });
    }
    try {
      const mode = String(req.body?.mode || req.query?.mode || 'soft_clear').trim();
      const nowMs = Date.now();
      const newCacheVersion = `v_${nowMs}`;

      res.setHeader('X-LiteSpeed-Purge', '*');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');

      db.cacheVersion = newCacheVersion;
      db.updatedAt = Math.max(Number(db.updatedAt || 0) + 1, nowMs);

      if (mode === 'reset_storefront_cache') {
        if (Array.isArray(req.body?.products) && req.body.products.length > 0) {
          db.products = req.body.products;
        }
        if (Array.isArray(req.body?.categories) && req.body.categories.length > 0) {
          db.categories = req.body.categories;
        }
        if (Array.isArray(req.body?.brands) && req.body.brands.length > 0) {
          db.brands = req.body.brands;
        }
        db.deletedProductIds = [];
      }

      migrateBase64ImagesInState(db);
      saveDbToDisk();

      return res.json({
        success: true,
        mode,
        cacheVersion: newCacheVersion,
        updatedAt: db.updatedAt,
        opcacheCleared: true,
        litespeedPurge: true
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Cache clear failed'
      });
    }
  };

  const handleOrderLimitCheck = (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const bizCfg = Array.isArray(db?.businesses) && db.businesses[0] ? db.businesses[0] : {};
    const ordersSource = Array.isArray(db?.onlineOrders) ? db.onlineOrders : [];
    const checkPhone = String(req.body?.phone ?? req.query?.phone ?? '').trim();
    const checkDevId = String(req.body?.clientDeviceId ?? req.query?.clientDeviceId ?? '').trim();
    const rawProdIds = req.body?.productIds ?? req.query?.productIds ?? [];
    const prodIdsArr = Array.isArray(rawProdIds)
      ? rawProdIds
      : typeof rawProdIds === 'string'
      ? rawProdIds.split(',').filter(Boolean)
      : [];
    const evalRes = evaluateDailyOrderLimitTs(
      ordersSource,
      bizCfg,
      checkPhone,
      getVisitorIpTs(req),
      checkDevId,
      prodIdsArr
    );
    return res.json({
      success: true,
      ...evalRes
    });
  };

  app.get('/api/state', handleGetState);
  app.post('/api/state', handlePostState);
  app.all('/api/order-limit-check', handleOrderLimitCheck);
  app.post('/api/upload-image', handleUploadImage);
  app.all('/api/clear-cache', handleClearCache);

  app.get('/api/cpanel-readiness', (req: Request, res: Response) => {
    if (!requireAdminDownloadAuthTs(req, res)) return;
    const checks = [
      {
        id: 'frontend_build',
        label: 'Compiled Frontend (index.php, cpanel-app.html & assets/app.bundle.js)',
        ready:
          fs.existsSync(path.join(__dirname, 'dist', 'index.html')) ||
          fs.existsSync(path.join(__dirname, 'assets', 'app.bundle.js'))
      },
      {
        id: 'htaccess',
        label: 'Apache SPA & API Router (public/.htaccess)',
        ready: fs.existsSync(path.join(__dirname, 'public', '.htaccess'))
      },
      {
        id: 'php_installer',
        label: '1-Click Auto-Installer (install.php / api/install.php)',
        ready: fs.existsSync(path.join(__dirname, 'backend', 'api', 'install.php'))
      },
      {
        id: 'mysql_sql',
        label: 'MySQL 16-Table Schema & Seed (cpanel_complete_install.sql)',
        ready: fs.existsSync(path.join(__dirname, 'database', 'cpanel_complete_install.sql'))
      },
      {
        id: 'php_api_sms',
        label: 'PHP 8.2 REST + Alpha SMS + Facebook CAPI Proxy (ApiController.php)',
        ready: fs.existsSync(path.join(__dirname, 'backend', 'controllers', 'ApiController.php'))
      }
    ];
    res.json({
      success: true,
      allReady: checks.every(c => c.ready),
      checks
    });
  });

  // Strict Meta CAPI Normalization & SHA-256 Hashing Helpers
  // Kept 100% identical across JavaScript (facebookTracking.ts), PHP (ApiController.php), and Node.js (server.ts)
  const isSha256Hex = (val: string): boolean => /^[a-f0-9]{64}$/i.test(val.trim());

  const utf8LowerTrimServer = (raw: string): string =>
    String(raw || '')
      .normalize('NFC')
      .trim()
      .toLowerCase();

  const sha256HashServer = (raw: string): string => {
    const clean = utf8LowerTrimServer(raw);
    if (!clean) return '';
    if (isSha256Hex(clean)) return clean.toLowerCase();
    return crypto.createHash('sha256').update(clean, 'utf8').digest('hex');
  };

  const normalizeBdPhoneForCapiServer = (phone: string): string => {
    const enDigits = String(phone || '').replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
    const digits = enDigits.replace(/\D/g, '').replace(/^00+/, '');
    if (!digits) return '';
    let candidate = '';
    if (digits.startsWith('8801') && digits.length === 13) {
      candidate = digits;
    } else if (digits.startsWith('01') && digits.length === 11) {
      candidate = `88${digits}`;
    } else if (digits.length === 10 && digits.startsWith('1')) {
      candidate = `880${digits}`;
    }
    return /^8801[3-9]\d{8}$/.test(candidate) ? candidate : '';
  };

  const BD_HONORIFIC_PREFIXES_SERVER = new Set<string>([
    'md', 'mohammad', 'muhammad', 'mohammed', 'mst', 'most', 'mr', 'mrs', 'ms', 'dr',
    'alhaj', 'haji', 'engr', 'adv',
    'মোঃ', 'মো', 'মোহাম্মদ', 'মুহাম্মদ', 'মোসাঃ', 'মোছাঃ', 'জনাব', 'ডঃ', 'ডাঃ', 'হাজী', 'আলহাজ্ব'
  ]);

  const splitNameForCapiServer = (fullName: string): { fn: string; ln: string } => {
    const cleaned = utf8LowerTrimServer(fullName)
      .replace(/[0-9.,/#!$%^&*;:{}=\-_`~()'"\\|<>?+[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return { fn: '', ln: '' };
    const parts = cleaned.split(' ').filter(Boolean);
    while (parts.length > 1 && BD_HONORIFIC_PREFIXES_SERVER.has(parts[0])) {
      parts.shift();
    }
    if (parts.length === 0) return { fn: '', ln: '' };
    if (parts.length === 1) return { fn: parts[0], ln: '' };
    return { fn: parts[0], ln: parts.slice(1).join(' ') };
  };

  const normalizeNameTokenServer = (token: string): string =>
    utf8LowerTrimServer(token)
      .replace(/[0-9.,/#!$%^&*;:{}=\-_`~()'"\\|<>?+[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const normalizeCityStateServer = (val: string): string =>
    utf8LowerTrimServer(val).replace(/[^a-z0-9\u0980-\u09ff]/g, '');

  const isValidPublicClientIpServer = (ip: string): boolean => {
    const clean = String(ip || '').trim().replace(/^::ffff:/i, '');
    if (
      !clean ||
      clean === '127.0.0.1' ||
      clean === '::1' ||
      clean === '0.0.0.0' ||
      clean.toLowerCase() === 'localhost'
    ) {
      return false;
    }
    if (
      /^10\./.test(clean) ||
      /^192\.168\./.test(clean) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean) ||
      /^169\.254\./.test(clean) ||
      /^fc00:/i.test(clean) ||
      /^fe80:/i.test(clean)
    ) {
      return false;
    }
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(clean) || clean.includes(':');
  };

  const toHashedArrayServer = (
    input: unknown,
    normalizer?: (val: string) => string
  ): string[] | undefined => {
    const rawValues: string[] = [];
    const collect = (item: unknown) => {
      if (Array.isArray(item)) {
        item.forEach(collect);
      } else if (item !== undefined && item !== null) {
        const s = String(item).trim();
        if (s) rawValues.push(s);
      }
    };
    collect(input);
    if (rawValues.length === 0) return undefined;

    const hashedList: string[] = [];
    for (const item of rawValues) {
      if (isSha256Hex(item)) {
        hashedList.push(item.toLowerCase());
      } else {
        const normalized = normalizer ? normalizer(item) : utf8LowerTrimServer(item);
        if (normalized) {
          const hashed = sha256HashServer(normalized);
          if (hashed) hashedList.push(hashed);
        }
      }
    }
    return hashedList.length > 0 ? Array.from(new Set(hashedList)) : undefined;
  };

  // Server-Side Facebook Conversions API (CAPI) Handler (Strict Normalization, SHA-256 Hashing & Unhashed Server Params)
  const handleFacebookCapi = async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      let pixelId = String(body.pixel_id || '').trim();
      let accessToken = String(body.access_token || '').trim();
      let testEventCode = String(body.test_event_code || '').trim();
      const omitSenderIpUa = Boolean(body.omit_sender_ip_ua);
      const event = body.event && typeof body.event === 'object' ? { ...body.event } : null;
      const rawUser =
        body.raw_user_data && typeof body.raw_user_data === 'object' ? body.raw_user_data : {};

      // Fallback to persisted business config on server disk if not sent in request
      if ((!pixelId || !accessToken) && Array.isArray(db.businesses) && db.businesses[0]) {
        const biz = db.businesses[0];
        if (!pixelId) pixelId = String(biz.fbPixelId || '').trim();
        if (!accessToken) accessToken = String(biz.fbAccessToken || '').trim();
        if (!testEventCode) testEventCode = String(biz.fbTestEventCode || '').trim();
      }

      if (!pixelId || !accessToken || !event) {
        return res.status(400).json({
          success: false,
          error: 'pixel_id, access_token, and event payload are required for CAPI'
        });
      }

      // 1. Extract accurate Client IP & User-Agent from request headers / socket (Unhashed, excluding loopback/private IPs & respecting omit_sender_ip_ua)
      let requestIp = '';
      if (!omitSenderIpUa) {
        const cfIp = String(req.headers['cf-connecting-ip'] || '').trim();
        const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const realIp = String(req.headers['x-real-ip'] || '').trim();
        const remoteAddr = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '').trim();
        for (const cand of [cfIp, xff, realIp, remoteAddr]) {
          if (isValidPublicClientIpServer(cand)) {
            requestIp = cand.replace(/^::ffff:/i, '');
            break;
          }
        }
      }
      const requestUa = omitSenderIpUa ? '' : String(req.headers['user-agent'] || '').trim();

      const incomingUserData =
        event.user_data && typeof event.user_data === 'object' ? event.user_data : {};

      // 2. Normalize & SHA-256 Hash PII fields into Arrays of Hashed Strings as required by Meta CAPI
      const rawFullName = String(rawUser.name || '').trim();
      const splitName = splitNameForCapiServer(rawFullName);
      const rawFn = splitName.fn || String(rawUser.fn || '').trim();
      const rawLn = splitName.ln || String(rawUser.ln || '').trim();

      const phArray =
        toHashedArrayServer(rawUser.phone, normalizeBdPhoneForCapiServer) ||
        toHashedArrayServer(incomingUserData.ph, normalizeBdPhoneForCapiServer);
      const emArray =
        toHashedArrayServer(rawUser.email, utf8LowerTrimServer) ||
        toHashedArrayServer(incomingUserData.em, utf8LowerTrimServer);
      const fnArray =
        toHashedArrayServer(rawFn, normalizeNameTokenServer) ||
        toHashedArrayServer(incomingUserData.fn, normalizeNameTokenServer);
      const lnArray =
        toHashedArrayServer(rawLn, normalizeNameTokenServer) ||
        toHashedArrayServer(incomingUserData.ln, normalizeNameTokenServer);
      const ctArray =
        toHashedArrayServer(rawUser.city, normalizeCityStateServer) ||
        toHashedArrayServer(incomingUserData.ct, normalizeCityStateServer);
      const stArray =
        toHashedArrayServer(rawUser.state, normalizeCityStateServer) ||
        toHashedArrayServer(incomingUserData.st, normalizeCityStateServer);
      const zpArray =
        toHashedArrayServer(rawUser.zip, utf8LowerTrimServer) ||
        toHashedArrayServer(incomingUserData.zp, utf8LowerTrimServer);

      // Preserve the COMPLETE external_id array (combining persistent UUID + normalized phone + incoming hashes)
      const externalIdArray = toHashedArrayServer(
        [rawUser.external_ids, rawUser.external_id, incomingUserData.external_id],
        utf8LowerTrimServer
      );

      // Always send SHA-256 hash of 'bd' as an array
      const countryArray = [sha256HashServer('bd')];

      const normalizedUserData: Record<string, any> = {
        country: countryArray
      };

      const explicitIp = String(
        incomingUserData.client_ip_address || rawUser.client_ip_address || ''
      ).trim();
      const finalIp = isValidPublicClientIpServer(explicitIp)
        ? explicitIp.replace(/^::ffff:/i, '')
        : requestIp;
      if (finalIp) {
        normalizedUserData.client_ip_address = finalIp;
      }

      const finalUa = String(
        incomingUserData.client_user_agent ||
          rawUser.client_user_agent ||
          body.client_user_agent ||
          requestUa ||
          ''
      ).trim();
      if (finalUa) {
        normalizedUserData.client_user_agent = finalUa;
      }

      if (phArray) normalizedUserData.ph = phArray;
      if (emArray) normalizedUserData.em = emArray;
      if (fnArray) normalizedUserData.fn = fnArray;
      if (lnArray) normalizedUserData.ln = lnArray;
      if (ctArray) normalizedUserData.ct = ctArray;
      if (stArray) normalizedUserData.st = stArray;
      if (zpArray) normalizedUserData.zp = zpArray;
      if (externalIdArray) normalizedUserData.external_id = externalIdArray;

      // Ensure fbp and fbc are sent UNHASHED
      const fbpVal = String(incomingUserData.fbp || rawUser.fbp || body._fbp || body.fbp || '').trim();
      const fbcVal = String(incomingUserData.fbc || rawUser.fbc || body._fbc || body.fbc || '').trim();
      if (fbpVal) normalizedUserData.fbp = fbpVal;
      if (fbcVal) normalizedUserData.fbc = fbcVal;

      const allowedCapiEvents = new Set([
        'PageView',
        'ViewContent',
        'Search',
        'AddToCart',
        'InitiateCheckout',
        'AddPaymentInfo',
        'Lead',
        'CompleteRegistration',
        'Purchase'
      ]);
      const incomingEventName = String(event.event_name || '').trim();
      if (incomingEventName && !allowedCapiEvents.has(incomingEventName)) {
        return res.status(400).json({
          success: false,
          error: 'Unsupported CAPI event_name'
        });
      }

      event.user_data = normalizedUserData;
      event.action_source = event.action_source || 'website';
      event.event_time = Number(event.event_time) || Math.floor(Date.now() / 1000);

      const rawSourceUrl = String(
        event.event_source_url || body.event_source_url || req.headers.referer || ''
      ).trim();
      const defaultOriginUrl = `${req.protocol}://${req.get('host') || 'localhost:3000'}/`;
      event.event_source_url =
        !rawSourceUrl ||
        /\/smart(\/|$|\?|#)/i.test(rawSourceUrl) ||
        /[?&]route=smart/i.test(rawSourceUrl)
          ? defaultOriginUrl
          : rawSourceUrl;

      const finalEventId = String(event.event_id || body.event_id || '').trim();
      if (finalEventId) {
        event.event_id = finalEventId;
      }

      const graphPayload: Record<string, any> = {
        data: [event]
      };
      if (testEventCode) {
        graphPayload.test_event_code = testEventCode;
      }

      const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(accessToken)}`;
      const fbRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(graphPayload)
      });
      const fbData: any = await fbRes.json().catch(() => null);

      if (fbRes.ok && fbData && fbData.events_received !== undefined) {
        return res.json({
          success: true,
          events_received: fbData.events_received,
          fbtrace_id: fbData.fbtrace_id || '',
          client_ip_detected: normalizedUserData.client_ip_address || '',
          event_id: event.event_id || ''
        });
      }

      return res.status(fbRes.status || 400).json({
        success: false,
        error: fbData?.error?.message || 'Meta Graph API rejected event',
        details: fbData
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to connect to graph.facebook.com'
      });
    }
  };

  app.post('/api/order-telemetry', handleFacebookCapi);
  app.post('/api/fb/capi', handleFacebookCapi);
  app.post('/api/fb-capi', handleFacebookCapi);

  // WordPress (WooCommerce REST API v3) Server-Side Order Creation, Product Matching & Connection Test Proxy
  const handleWordPressOrderSync = async (req: Request, res: Response) => {
    try {
      const { action, siteUrl, consumerKey, consumerSecret, orderPayload, rawOrder, product } =
        req.body || {};
      const cleanSiteUrl = String(siteUrl || '')
        .trim()
        .replace(/\/wp-json.*$/i, '')
        .replace(/\/wp-admin.*$/i, '')
        .replace(/\/+$/, '');
      const ck = String(consumerKey || '').trim();
      const cs = String(consumerSecret || '').trim();

      if (!cleanSiteUrl || !ck || !cs) {
        return res.status(400).json({
          ok: false,
          message: 'WordPress Site URL, Consumer Key (ck_...) এবং Consumer Secret (cs_...) আবশ্যক।'
        });
      }

      // SSRF Protection: Only permit public HTTP/HTTPS WordPress URLs (block loopback, private IPs & metadata endpoints)
      try {
        const parsedWpUrl = new URL(cleanSiteUrl);
        const hostLower = parsedWpUrl.hostname.toLowerCase();
        const isPrivateOrLocal =
          hostLower === 'localhost' ||
          hostLower === '127.0.0.1' ||
          hostLower === '0.0.0.0' ||
          hostLower === '::1' ||
          hostLower === '169.254.169.254' ||
          hostLower.startsWith('10.') ||
          hostLower.startsWith('192.168.') ||
          /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostLower);
        if ((parsedWpUrl.protocol !== 'https:' && parsedWpUrl.protocol !== 'http:') || isPrivateOrLocal) {
          return res.status(400).json({
            ok: false,
            message: 'অবৈধ WordPress Site URL। অনুগ্রহ করে একটি বৈধ পাবলিক ওয়েবসাইট লিংক (https://...) দিন।'
          });
        }
      } catch {
        return res.status(400).json({
          ok: false,
          message: 'WordPress Site URL সঠিক ফরম্যাটে নেই (যেমন: https://yourwordpress.com)।'
        });
      }

      const authHeader =
        'Basic ' + Buffer.from(`${ck}:${cs}`, 'utf-8').toString('base64');
      const queryAuth = `consumer_key=${encodeURIComponent(ck)}&consumer_secret=${encodeURIComponent(cs)}`;
      const commonHeaders = {
        Authorization: authHeader,
        Accept: 'application/json',
        'User-Agent': 'StockMasterBD-WooCommerce-Sync/2.0'
      };

      // 1. Test Connection
      if (action === 'test_connection') {
        const testUrl = `${cleanSiteUrl}/wp-json/wc/v3/orders?per_page=1&${queryAuth}`;
        const response = await fetch(testUrl, {
          method: 'GET',
          headers: commonHeaders
        });

        if (response.ok) {
          return res.json({
            ok: true,
            message: `সফলভাবে কানেক্ট হয়েছে! (${cleanSiteUrl} - WooCommerce REST API v3 রেডি)`
          });
        }

        const errData: any = await response.json().catch(() => null);
        return res.json({
          ok: false,
          message:
            errData?.message ||
            `WordPress সার্ভার রেসপন্স HTTP ${response.status}। আপনার Consumer Key/Secret (Read/Write) এবং Permalink সেটিংস যাচাই করুন।`
        });
      }

      // 2. Fetch Remote WooCommerce Products List (for 1-Click Auto-Match in Admin)
      if (action === 'fetch_products') {
        const prodUrl = `${cleanSiteUrl}/wp-json/wc/v3/products?per_page=100&${queryAuth}`;
        const response = await fetch(prodUrl, {
          method: 'GET',
          headers: commonHeaders
        });
        const list: any = await response.json().catch(() => []);
        if (response.ok && Array.isArray(list)) {
          const products = list.map((p: any) => ({
            id: Number(p.id),
            name: String(p.name || ''),
            sku: String(p.sku || ''),
            price: String(p.price || p.regular_price || '0'),
            regular_price: String(p.regular_price || p.price || '0'),
            status: String(p.status || 'publish'),
            permalink: p.permalink ? String(p.permalink) : undefined
          }));
          return res.json({
            ok: true,
            products,
            message: `WordPress থেকে ${products.length} টি প্রোডাক্ট সফলভাবে লোড হয়েছে!`
          });
        }
        return res.json({
          ok: false,
          products: [],
          message: list?.message || `WordPress প্রোডাক্ট লিস্ট লোড ব্যর্থ (HTTP ${response.status})`
        });
      }

      // Helper to resolve or auto-create a WooCommerce Product AND its Size Variation (by Variation SKU or Size Option)
      const resolveOrCreateWooProductAndVariation = async (opts: {
        localProductId?: string;
        wpProductId?: number;
        wpVariationId?: number;
        sku?: string;
        parentSku?: string;
        variantSku?: string;
        cleanName: string;
        variantText?: string;
        unitPrice: number;
        regularPrice?: number;
        description?: string;
        allVariants?: Array<{
          id: string;
          label: string;
          sku?: string;
          wpVariationId?: number;
          retailPrice: number;
          regularPrice?: number;
        }>;
      }): Promise<{
        productId: number;
        variationId: number;
        variantMappings: Array<{ id: string; sku: string; wpVariationId: number }>;
      }> => {
        let resolvedProductId = opts.wpProductId && Number(opts.wpProductId) > 0 ? Number(opts.wpProductId) : 0;
        let resolvedVariationId =
          opts.wpVariationId && Number(opts.wpVariationId) > 0 ? Number(opts.wpVariationId) : 0;
        const variantMappings: Array<{ id: string; sku: string; wpVariationId: number }> = [];

        const localProd = Array.isArray(db.products)
          ? db.products.find(
              (p: any) =>
                (opts.localProductId && p.id === opts.localProductId) ||
                (opts.parentSku && String(p.sku || '').toLowerCase() === opts.parentSku.toLowerCase()) ||
                (opts.sku && String(p.sku || '').toLowerCase() === opts.sku.toLowerCase()) ||
                String(p.nameBn || '').trim().toLowerCase() === opts.cleanName.toLowerCase()
            )
          : null;

        if (!resolvedProductId && localProd && Number(localProd.wpProductId) > 0) {
          resolvedProductId = Number(localProd.wpProductId);
        }

        const effectiveParentSku = (opts.parentSku || localProd?.sku || opts.sku || '').trim();
        const effectiveVarSku = (opts.variantSku || opts.sku || '').trim();
        const effectiveSku = (effectiveVarSku || effectiveParentSku).trim();
        const cleanVariantLabel = (opts.variantText || '').trim();

        // Check local variant cache first if variantText or sku matches
        if (!resolvedVariationId && localProd && Array.isArray(localProd.variants)) {
          const matchedLocalVar = localProd.variants.find(
            (v: any) =>
              (effectiveVarSku && v.sku && String(v.sku).toLowerCase() === effectiveVarSku.toLowerCase()) ||
              (cleanVariantLabel &&
                String(v.label || '').trim().toLowerCase() === cleanVariantLabel.toLowerCase())
          );
          if (matchedLocalVar && Number(matchedLocalVar.wpVariationId) > 0) {
            resolvedVariationId = Number(matchedLocalVar.wpVariationId);
          }
        }

        // A. Lookup in WooCommerce by Variation SKU or Item SKU (handles BOTH Variation SKU and Simple/Parent Product SKU!)
        if (effectiveSku && (!resolvedProductId || (cleanVariantLabel && !resolvedVariationId))) {
          try {
            const skuUrl = `${cleanSiteUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(
              effectiveSku
            )}&${queryAuth}`;
            const skuRes = await fetch(skuUrl, { method: 'GET', headers: commonHeaders });
            const skuList: any = await skuRes.json().catch(() => []);
            if (skuRes.ok && Array.isArray(skuList) && skuList.length > 0) {
              const firstHit = skuList[0];
              if (Number(firstHit.parent_id) > 0) {
                // Matched a WooCommerce Variation directly by Variation SKU!
                resolvedProductId = Number(firstHit.parent_id);
                resolvedVariationId = Number(firstHit.id);
              } else if (Number(firstHit.id) > 0) {
                resolvedProductId = Number(firstHit.id);
              }
            }
          } catch {
            // Continue
          }
        }

        // B. If still no parent Product ID, check parent product's SKU
        if (!resolvedProductId && effectiveParentSku && effectiveParentSku !== effectiveSku) {
          try {
            const pSkuUrl = `${cleanSiteUrl}/wp-json/wc/v3/products?sku=${encodeURIComponent(
              effectiveParentSku
            )}&${queryAuth}`;
            const pSkuRes = await fetch(pSkuUrl, { method: 'GET', headers: commonHeaders });
            const pSkuList: any = await pSkuRes.json().catch(() => []);
            if (pSkuRes.ok && Array.isArray(pSkuList) && pSkuList.length > 0 && pSkuList[0].id) {
              resolvedProductId =
                Number(pSkuList[0].parent_id) > 0
                  ? Number(pSkuList[0].parent_id)
                  : Number(pSkuList[0].id);
            }
          } catch {
            // Continue
          }
        }

        // C. Lookup in WooCommerce by Product Name search
        if (!resolvedProductId && opts.cleanName) {
          try {
            const searchUrl = `${cleanSiteUrl}/wp-json/wc/v3/products?search=${encodeURIComponent(
              opts.cleanName
            )}&per_page=10&${queryAuth}`;
            const searchRes = await fetch(searchUrl, { method: 'GET', headers: commonHeaders });
            const searchList: any = await searchRes.json().catch(() => []);
            if (searchRes.ok && Array.isArray(searchList) && searchList.length > 0) {
              const exact = searchList.find(
                (p: any) =>
                  String(p.name || '').trim().toLowerCase() === opts.cleanName.toLowerCase()
              );
              const chosen = exact || searchList[0];
              resolvedProductId =
                Number(chosen.parent_id) > 0 ? Number(chosen.parent_id) : Number(chosen.id || 0);
            }
          } catch {
            // Continue
          }
        }

        const variantsToSync =
          opts.allVariants && opts.allVariants.length > 0
            ? opts.allVariants
            : Array.isArray(localProd?.variants) && localProd.variants.length > 0
            ? localProd.variants
            : [];

        // D. Auto-Create the product in WooCommerce if not found
        if (!resolvedProductId && opts.cleanName) {
          try {
            const regPrice = Math.max(opts.regularPrice || opts.unitPrice, opts.unitPrice);
            const hasSale = opts.unitPrice < regPrice;
            const createProdUrl = `${cleanSiteUrl}/wp-json/wc/v3/products?${queryAuth}`;
            const hasMultipleVariants = variantsToSync.length > 0 || Boolean(cleanVariantLabel);
            const optionLabels =
              variantsToSync.length > 0
                ? Array.from(
                    new Set([
                      ...variantsToSync.map((v: any) => String(v.label).trim()),
                      ...(cleanVariantLabel ? [cleanVariantLabel] : [])
                    ])
                  )
                : cleanVariantLabel
                ? [cleanVariantLabel]
                : [];

            const prodBody: Record<string, any> = {
              name: opts.cleanName,
              type: hasMultipleVariants ? 'variable' : 'simple',
              status: 'publish',
              regular_price: String(regPrice),
              ...(hasSale ? { sale_price: String(opts.unitPrice) } : {}),
              ...(effectiveParentSku ? { sku: effectiveParentSku } : {}),
              ...(opts.description ? { description: opts.description } : {}),
              ...(hasMultipleVariants && optionLabels.length > 0
                ? {
                    attributes: [
                      {
                        name: 'Size',
                        visible: true,
                        variation: true,
                        options: optionLabels
                      }
                    ]
                  }
                : {})
            };

            let createProdRes = await fetch(createProdUrl, {
              method: 'POST',
              headers: {
                ...commonHeaders,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(prodBody)
            });
            let createdProd: any = await createProdRes.json().catch(() => null);

            if ((!createProdRes.ok || !createdProd?.id) && prodBody.sku) {
              // Retry without SKU in case SKU conflicted with a draft/trashed product in WordPress
              delete prodBody.sku;
              createProdRes = await fetch(createProdUrl, {
                method: 'POST',
                headers: {
                  ...commonHeaders,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(prodBody)
              });
              createdProd = await createProdRes.json().catch(() => null);
            }

            if (createProdRes.ok && createdProd && createdProd.id) {
              resolvedProductId = Number(createdProd.id);
            }
          } catch {
            // Continue to fallback
          }
        }

        // E. Resolve or Create Variations (Size + Variation SKU) when productId is valid
        if (resolvedProductId > 0 && (cleanVariantLabel || variantsToSync.length > 0)) {
          try {
            const varListUrl = `${cleanSiteUrl}/wp-json/wc/v3/products/${resolvedProductId}/variations?per_page=100&${queryAuth}`;
            const varListRes = await fetch(varListUrl, { method: 'GET', headers: commonHeaders });
            const existingVars: any[] = (await varListRes.json().catch(() => [])) || [];
            const validExistingVars = Array.isArray(existingVars) ? existingVars : [];

            const getVarCandidateTokens = (rawLabel: string): string[] => {
              if (!rawLabel) return [];
              const tokens = new Set<string>();
              const clean = rawLabel.trim();
              if (!clean) return [];

              tokens.add(clean.toLowerCase());

              // Extract English in parentheses: "৫-৬ বছর (5-6 Years)" -> "5-6 Years"
              const parenMatch = clean.match(/\(([^()]+)\)/);
              if (parenMatch && parenMatch[1]) {
                const inner = parenMatch[1].trim();
                tokens.add(inner.toLowerCase());
                const outer = clean.replace(/\([^()]*\)/g, '').trim();
                if (outer) tokens.add(outer.toLowerCase());
              }

              // Convert Bengali digits to English digits
              const bnDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
              let converted = clean;
              for (let i = 0; i < 10; i++) {
                converted = converted.split(bnDigits[i]).join(String(i));
              }
              tokens.add(converted.toLowerCase());

              const currentTokens = Array.from(tokens);
              for (const t of currentTokens) {
                const slug = t
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '');
                if (slug) tokens.add(slug);

                const shortY = t
                  .toLowerCase()
                  .replace(/years?/g, 'y')
                  .replace(/\s+/g, '')
                  .replace(/[^a-z0-9]/g, '');
                if (shortY) tokens.add(shortY);
              }

              return Array.from(tokens).filter(Boolean);
            };

            // Helper to find an existing WooCommerce variation by SKU or Size option
            const findMatchingRemoteVar = (targetSku?: string, targetLabel?: string) => {
              const sClean = (targetSku || '').trim().toLowerCase();
              const candidateTokens = targetLabel ? getVarCandidateTokens(targetLabel) : [];
              return validExistingVars.find((rv: any) => {
                if (sClean && String(rv.sku || '').trim().toLowerCase() === sClean) {
                  return true;
                }
                if (candidateTokens.length > 0 && Array.isArray(rv.attributes)) {
                  return rv.attributes.some((attr: any) => {
                    const opt = String(attr?.option || '').trim().toLowerCase();
                    const slug = String(attr?.slug || '').trim().toLowerCase();
                    const cleanOptSlug = opt.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                    return candidateTokens.some(tok => tok === opt || tok === slug || tok === cleanOptSlug);
                  });
                }
                return false;
              });
            };

            // If syncing all variants of a product (`sync_product`), match or create each variation in WooCommerce
            if (variantsToSync.length > 0 && action === 'sync_product') {
              const allOptionLabels = variantsToSync.map((v: any) => String(v.label).trim());
              await fetch(`${cleanSiteUrl}/wp-json/wc/v3/products/${resolvedProductId}?${queryAuth}`, {
                method: 'PUT',
                headers: { ...commonHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'variable',
                  attributes: [
                    {
                      name: 'Size',
                      visible: true,
                      variation: true,
                      options: allOptionLabels
                    }
                  ]
                })
              }).catch(() => {});

              for (const v of variantsToSync) {
                const vSku = String(v.sku || '').trim();
                const vLabel = String(v.label || '').trim();
                const existingMatch = findMatchingRemoteVar(vSku, vLabel);

                if (existingMatch && existingMatch.id) {
                  variantMappings.push({
                    id: v.id,
                    sku: vSku || String(existingMatch.sku || ''),
                    wpVariationId: Number(existingMatch.id)
                  });
                } else {
                  const vReg = Math.max(Number(v.regularPrice || v.retailPrice), Number(v.retailPrice));
                  const vSale = Number(v.retailPrice) < vReg ? String(v.retailPrice) : undefined;
                  const createVarBody: Record<string, any> = {
                    regular_price: String(vReg),
                    ...(vSale ? { sale_price: vSale } : {}),
                    ...(vSku ? { sku: vSku } : {}),
                    attributes: [{ name: 'Size', option: vLabel }]
                  };
                  let cVarRes = await fetch(
                    `${cleanSiteUrl}/wp-json/wc/v3/products/${resolvedProductId}/variations?${queryAuth}`,
                    {
                      method: 'POST',
                      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
                      body: JSON.stringify(createVarBody)
                    }
                  );
                  let cVarJson: any = await cVarRes.json().catch(() => null);
                  if ((!cVarRes.ok || !cVarJson?.id) && createVarBody.sku) {
                    delete createVarBody.sku;
                    cVarRes = await fetch(
                      `${cleanSiteUrl}/wp-json/wc/v3/products/${resolvedProductId}/variations?${queryAuth}`,
                      {
                        method: 'POST',
                        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
                        body: JSON.stringify(createVarBody)
                      }
                    );
                    cVarJson = await cVarRes.json().catch(() => null);
                  }
                  if (cVarRes.ok && cVarJson && cVarJson.id) {
                    variantMappings.push({
                      id: v.id,
                      sku: vSku,
                      wpVariationId: Number(cVarJson.id)
                    });
                  }
                }
              }
            }

            // If resolving a specific order item's variation (`cleanVariantLabel` or `effectiveVarSku`)
            if (!resolvedVariationId && (cleanVariantLabel || effectiveVarSku)) {
              const matchedRemoteVar = findMatchingRemoteVar(effectiveVarSku, cleanVariantLabel);
              if (matchedRemoteVar && matchedRemoteVar.id) {
                resolvedVariationId = Number(matchedRemoteVar.id);
              } else if (cleanVariantLabel) {
                // Auto-create this variation on the parent product in WordPress so WooCommerce gets a real variation_id!
                const allOpts = Array.from(
                  new Set([
                    ...variantsToSync.map((v: any) => String(v.label).trim()),
                    ...validExistingVars.flatMap((rv: any) =>
                      Array.isArray(rv.attributes)
                        ? rv.attributes.map((a: any) => String(a.option || '').trim()).filter(Boolean)
                        : []
                    ),
                    cleanVariantLabel
                  ])
                );
                await fetch(`${cleanSiteUrl}/wp-json/wc/v3/products/${resolvedProductId}?${queryAuth}`, {
                  method: 'PUT',
                  headers: { ...commonHeaders, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: 'variable',
                    attributes: [
                      {
                        name: 'Size',
                        visible: true,
                        variation: true,
                        options: allOpts
                      }
                    ]
                  })
                }).catch(() => {});

                const createVarBody: Record<string, any> = {
                  regular_price: String(opts.unitPrice || 0),
                  ...(effectiveVarSku ? { sku: effectiveVarSku } : {}),
                  attributes: [{ name: 'Size', option: cleanVariantLabel }]
                };
                let cVarRes = await fetch(
                  `${cleanSiteUrl}/wp-json/wc/v3/products/${resolvedProductId}/variations?${queryAuth}`,
                  {
                    method: 'POST',
                    headers: { ...commonHeaders, 'Content-Type': 'application/json' },
                    body: JSON.stringify(createVarBody)
                  }
                );
                let cVarJson: any = await cVarRes.json().catch(() => null);
                if ((!cVarRes.ok || !cVarJson?.id) && createVarBody.sku) {
                  delete createVarBody.sku;
                  cVarRes = await fetch(
                    `${cleanSiteUrl}/wp-json/wc/v3/products/${resolvedProductId}/variations?${queryAuth}`,
                    {
                      method: 'POST',
                      headers: { ...commonHeaders, 'Content-Type': 'application/json' },
                      body: JSON.stringify(createVarBody)
                    }
                  );
                  cVarJson = await cVarRes.json().catch(() => null);
                }
                if (cVarRes.ok && cVarJson && cVarJson.id) {
                  resolvedVariationId = Number(cVarJson.id);
                }
              }
            }
          } catch {
            // Ignore variation fetch error and continue with parent productId + Size meta_data
          }
        }

        // Save resolved wpProductId & wpVariationId to local db.products so future orders are instant
        if (resolvedProductId > 0 && localProd) {
          let changed = false;
          if (!localProd.wpProductId) {
            localProd.wpProductId = resolvedProductId;
            changed = true;
          }
          if (Array.isArray(localProd.variants)) {
            localProd.variants = localProd.variants.map((lv: any) => {
              const m = variantMappings.find(vm => vm.id === lv.id);
              if (m && m.wpVariationId > 0) {
                changed = true;
                return { ...lv, wpVariationId: m.wpVariationId, sku: m.sku || lv.sku };
              }
              if (
                resolvedVariationId > 0 &&
                cleanVariantLabel &&
                String(lv.label || '').trim().toLowerCase() === cleanVariantLabel.toLowerCase() &&
                !lv.wpVariationId
              ) {
                changed = true;
                return { ...lv, wpVariationId: resolvedVariationId };
              }
              return lv;
            });
          }
          if (changed) {
            saveDbToDisk();
          }
        }

        return {
          productId: resolvedProductId,
          variationId: resolvedVariationId,
          variantMappings
        };
      };

      // 3. Single Product (+ Variations & SKUs) Sync / Auto-Link Action
      if (action === 'sync_product' && product) {
        const cleanName = String(product.nameBn || product.nameEn || 'Product').trim();
        const { productId: wpProdId, variantMappings } = await resolveOrCreateWooProductAndVariation({
          localProductId: product.id,
          wpProductId: product.wpProductId ? Number(product.wpProductId) : undefined,
          sku: product.sku,
          parentSku: product.sku,
          cleanName,
          unitPrice: Number(product.retailPrice) || 0,
          regularPrice: Number(product.regularPrice) || Number(product.retailPrice) || 0,
          description: product.description,
          allVariants: Array.isArray(product.variants) ? product.variants : []
        });

        if (wpProdId > 0) {
          const varMsg =
            variantMappings.length > 0
              ? ` এবং ${variantMappings.length} টি সাইজ ভ্যারিয়েশন (SKU সহ)`
              : '';
          return res.json({
            ok: true,
            wpProductId: wpProdId,
            variantMappings,
            message: `"${cleanName}"${varMsg} সফলভাবে WordPress প্রোডাক্ট #${wpProdId}-এর সাথে যুক্ত হয়েছে!`
          });
        }
        return res.json({
          ok: false,
          message: `"${cleanName}" WordPress-এ তৈরি বা ম্যাচ করা যায়নি। API Key Read/Write পারমিশন চেক করুন।`
        });
      }

      // 4. Default Action: create_order in WooCommerce with real `line_items` product + size variation assignment
      const finalPayload: Record<string, any> = { ...(orderPayload || {}) };
      const rawItems: any[] = Array.isArray(rawOrder?.items) ? rawOrder.items : [];

      if (rawItems.length > 0) {
        const resolvedLineItems: Array<Record<string, any>> = [];
        const unresolvedFeeItems: Array<Record<string, any>> = [];

        for (const item of rawItems) {
          const fullItemName = String(item.productName || 'Product').trim();
          const parenMatch = fullItemName.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
          const cleanName = String(
            item.productNameClean || (parenMatch ? parenMatch[1] : fullItemName)
          ).trim();
          const variantText = String(
            item.variantLabel || (parenMatch ? parenMatch[2] : '')
          ).trim();

          const { productId: wpProductId, variationId: wpVariationId } =
            await resolveOrCreateWooProductAndVariation({
              localProductId: item.productId,
              wpProductId: item.wpProductId ? Number(item.wpProductId) : undefined,
              wpVariationId: item.wpVariationId ? Number(item.wpVariationId) : undefined,
              sku: item.sku,
              parentSku: item.parentSku,
              variantSku: item.variantSku,
              cleanName,
              variantText,
              unitPrice: Number(item.unitPrice) || 0
            });

          const qty = Math.max(1, Number(item.quantity) || 1);
          const lineTotal = String(item.total ?? Number(item.unitPrice || 0) * qty);
          const effectiveItemSku = String(item.variantSku || item.sku || item.parentSku || '').trim();

          if (wpProductId > 0) {
            const metaData: Array<{ key: string; value: string }> = [];
            if (variantText) {
              metaData.push({ key: 'Size', value: variantText });
              metaData.push({ key: 'size', value: variantText });
              metaData.push({ key: 'pa_size', value: variantText });
              metaData.push({ key: 'attribute_pa_size', value: variantText });
              metaData.push({ key: 'attribute_size', value: variantText });
              metaData.push({ key: 'সাইজ / ভেরিয়েশন', value: variantText });
            }
            if (item.variantSku) {
              metaData.push({ key: 'Variation SKU', value: String(item.variantSku) });
            }
            if (item.parentSku) {
              metaData.push({ key: 'Product SKU', value: String(item.parentSku) });
            }
            if (effectiveItemSku) {
              metaData.push({ key: 'SKU', value: effectiveItemSku });
            }
            resolvedLineItems.push({
              product_id: wpProductId,
              ...(wpVariationId > 0 ? { variation_id: wpVariationId } : {}),
              ...(effectiveItemSku ? { sku: effectiveItemSku } : {}),
              name: fullItemName,
              quantity: qty,
              subtotal: lineTotal,
              total: lineTotal,
              ...(metaData.length > 0 ? { meta_data: metaData } : {})
            });
          } else {
            unresolvedFeeItems.push({
              name: `${fullItemName}${effectiveItemSku ? ` [${effectiveItemSku}]` : ''} × ${qty}`,
              total: lineTotal,
              tax_status: 'none'
            });
          }
        }

        if (resolvedLineItems.length > 0) {
          finalPayload.line_items = resolvedLineItems;
          if (unresolvedFeeItems.length > 0) {
            finalPayload.fee_lines = unresolvedFeeItems;
          } else {
            delete finalPayload.fee_lines;
          }
        }
      }

      const createUrl = `${cleanSiteUrl}/wp-json/wc/v3/orders?${queryAuth}`;
      let response = await fetch(createUrl, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(finalPayload)
      });

      let data: any = await response.json().catch(() => null);

      // If WooCommerce rejected a stale/deleted product_id in line_items, fallback cleanly so order never fails
      if ((!response.ok || !data?.id) && finalPayload.line_items) {
        const fallbackPayload: Record<string, any> = { ...(orderPayload || {}) };
        delete fallbackPayload.line_items;
        if (!fallbackPayload.fee_lines && rawItems.length > 0) {
          fallbackPayload.fee_lines = rawItems.map((it: any) => ({
            name: `${it.productName} × ${it.quantity}`,
            total: String(it.total),
            tax_status: 'none'
          }));
        }
        response = await fetch(createUrl, {
          method: 'POST',
          headers: {
            ...commonHeaders,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(fallbackPayload)
        });
        data = await response.json().catch(() => null);
      }

      if (response.ok && data && data.id) {
        return res.json({
          ok: true,
          wpOrderId: data.id,
          wpOrderStatus: data.status || 'processing',
          message: `WordPress ওয়েবসাইটে প্রোডাক্টসহ অর্ডার #${data.id} সফলভাবে তৈরি হয়েছে!`
        });
      }

      return res.json({
        ok: false,
        message:
          data?.message ||
          `WordPress-এ অর্ডার তৈরি ব্যর্থ হয়েছে (HTTP ${response.status})`
      });
    } catch (err: any) {
      return res.status(500).json({
        ok: false,
        message: `WordPress সংযোগ ত্রুটি: ${err?.message || 'Unknown error'}`
      });
    }
  };

  app.post('/api/wp-sync-order', handleWordPressOrderSync);

  // Dynamic Product Image HTTP Endpoint (converts base64 data:image/... or fallback to HTTP image for Meta Catalog)
  const handleProductImageRequest = (req: Request, res: Response) => {
    const productId = String(req.params?.id || req.query?.id || '').trim();
    const productsList = Array.isArray(db.products) ? db.products : initialProducts;
    const product = productsList.find((p: any) => String(p?.id || '') === productId);
    const rawImg = String(product?.image || product?.galleryImages?.[0] || '').trim();

    if (rawImg.startsWith('data:image/')) {
      const match = rawImg.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64Data = match[2];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.end(imgBuffer);
      }
    }

    if (rawImg.startsWith('http://') || rawImg.startsWith('https://') || rawImg.startsWith('/uploads/')) {
      return res.redirect(302, rawImg);
    }

    // Fallback SVG Product Image Card
    const title = String(product?.nameEn || product?.nameBn || product?.sku || 'Product')
      .replace(/[<>&"']/g, '');
    const price = Number(product?.retailPrice || 0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
      <rect width="800" height="800" fill="#f8fafc"/>
      <rect x="40" y="40" width="720" height="720" rx="40" fill="#ffffff" stroke="#e2e8f0" stroke-width="6"/>
      <text x="400" y="370" text-anchor="middle" font-family="sans-serif" font-size="38" font-weight="bold" fill="#0f172a">${title.slice(0, 32)}</text>
      <text x="400" y="445" text-anchor="middle" font-family="monospace" font-size="46" font-weight="bold" fill="#047857">BDT ${price}</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(svg);
  };

  // Dynamic Facebook / Meta Catalog Feed Generator (XML & CSV)
  const buildServerCatalogItems = (req: Request) => {
    const proto =
      String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .split(',')[0]
        .trim() || 'https';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000')
      .split(',')[0]
      .trim();
    const origin = `${proto}://${host}`;

    const productsList = Array.isArray(db.products) && db.products.length > 0 ? db.products : initialProducts;
    const businessesList = Array.isArray(db.businesses) && db.businesses.length > 0 ? db.businesses : initialBusinesses;
    const brandsList = Array.isArray(db.brands) ? db.brands : [];
    const currentBiz = businessesList[0] || initialBusinesses[0];
    const cleanStoreName =
      String(currentBiz?.name || '')
        .replace('স্টকমাস্টার বিডি - ', '')
        .trim() ||
      String(currentBiz?.nameEn || 'Online Store');

    const items = productsList.map((product: any) => {
      const stockObj = product?.stockByOutlet && typeof product.stockByOutlet === 'object' ? product.stockByOutlet : {};
      const totalStock = Object.values(stockObj).reduce(
        (sum: number, q: any) => sum + Math.max(0, Number(q) || 0),
        0
      );
      const availability = totalStock > 0 ? 'in stock' : 'out of stock';

      const primaryVariant =
        Array.isArray(product?.variants) && product.variants.length > 0 ? product.variants[0] : undefined;
      const sellingPrice = Number(primaryVariant ? primaryVariant.retailPrice : product?.retailPrice) || 0;
      const regularPriceRaw = Number(primaryVariant?.regularPrice ?? product?.regularPrice ?? 0);
      const discountPriceRaw = Number(primaryVariant?.discountPrice ?? product?.discountPrice ?? 0);
      const hasDiscount = regularPriceRaw > sellingPrice && discountPriceRaw !== 0;

      const regularPrice = hasDiscount ? regularPriceRaw : sellingPrice;
      const salePrice = hasDiscount ? sellingPrice : 0;

      const slugBase = String(product?.nameEn || product?.sku || product?.id || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const slug = slugBase ? `${slugBase}--${product.id}` : String(product.id);
      const link = `${origin}/product/${slug}`;

      const rawImg = String(product?.image || product?.galleryImages?.[0] || '').trim();
      const image_link =
        rawImg.startsWith('http://') || rawImg.startsWith('https://')
          ? rawImg
          : rawImg.startsWith('/') && !rawImg.startsWith('//')
          ? `${origin}${rawImg}`
          : `${origin}/api/index.php?route=product-image&id=${encodeURIComponent(String(product.id))}`;

      const brandObj = brandsList.find((b: any) => b?.id === product?.brandId);
      const brand = String(brandObj?.name || cleanStoreName).trim();

      const rawDesc =
        product?.description && String(product.description).trim() !== ''
          ? String(product.description).trim()
          : `${product?.nameBn || ''} (${product?.nameEn || ''}) — প্রিমিয়াম কোয়ালিটি ও নিখুঁত ফিনিশিং। সারাদেশে ক্যাশ অন ডেলিভারি সুবিধা।`;
      const cleanDesc = rawDesc
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      return {
        id: String(product.id).trim(),
        title: String(product?.nameBn || product?.nameEn || product?.sku || '').trim(),
        description: cleanDesc || String(product?.nameBn || product?.nameEn || ''),
        availability,
        condition: 'new',
        price: `${regularPrice.toFixed(0)} BDT`,
        sale_price: salePrice > 0 ? `${salePrice.toFixed(0)} BDT` : '',
        link,
        image_link,
        brand
      };
    });

    return { origin, cleanStoreName, items };
  };

  const handleFacebookCatalogFeedRequest = (req: Request, res: Response, format: 'xml' | 'csv') => {
    const { origin, cleanStoreName, items } = buildServerCatalogItems(req);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (format === 'csv') {
      const headers = [
        'id',
        'title',
        'description',
        'availability',
        'condition',
        'price',
        'sale_price',
        'link',
        'image_link',
        'brand'
      ] as const;
      const escapeCsv = (val: string) => {
        const clean = String(val ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (clean.includes(',') || clean.includes('"') || clean.includes('\n')) {
          return `"${clean.replace(/"/g, '""')}"`;
        }
        return clean;
      };
      const rows = [headers.join(',')];
      for (const item of items) {
        rows.push(headers.map(k => escapeCsv((item as any)[k] || '')).join(','));
      }
      const csvPayload = '\uFEFF' + rows.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      if (req.query.download === '1') {
        res.setHeader('Content-Disposition', 'attachment; filename="facebook-catalog-feed.csv"');
      } else {
        res.setHeader('Content-Disposition', 'inline; filename="facebook-catalog-feed.csv"');
      }
      return res.send(csvPayload);
    }

    // Default XML (RSS 2.0 with g: namespace)
    const escXml = (v: string) =>
      String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const xmlItems = items
      .map((item: any) => {
        const lines = [
          '    <item>',
          `      <g:id>${escXml(item.id)}</g:id>`,
          `      <g:title>${escXml(item.title)}</g:title>`,
          `      <g:description>${escXml(item.description)}</g:description>`,
          `      <g:availability>${escXml(item.availability)}</g:availability>`,
          `      <g:condition>${escXml(item.condition)}</g:condition>`,
          `      <g:price>${escXml(item.price)}</g:price>`
        ];
        if (item.sale_price) {
          lines.push(`      <g:sale_price>${escXml(item.sale_price)}</g:sale_price>`);
        }
        lines.push(
          `      <g:link>${escXml(item.link)}</g:link>`,
          `      <g:image_link>${escXml(item.image_link)}</g:image_link>`,
          `      <g:brand>${escXml(item.brand)}</g:brand>`,
          '    </item>'
        );
        return lines.join('\n');
      })
      .join('\n');

    const xmlPayload = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
      '  <channel>',
      `    <title>${escXml(cleanStoreName)} - Facebook Product Catalog Feed</title>`,
      `    <link>${escXml(origin)}</link>`,
      `    <description>${escXml(`Automatic Meta Commerce Manager Product Feed for ${cleanStoreName}`)}</description>`,
      xmlItems,
      '  </channel>',
      '</rss>'
    ].join('\n');

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', 'attachment; filename="facebook-catalog-feed.xml"');
    }
    return res.send(xmlPayload);
  };

  app.get('/api/product-image/:id', handleProductImageRequest);
  app.get(['/api/facebook-feed.xml', '/api/facebook-catalog.xml', '/api/facebook-feed', '/api/facebook-catalog'], (req: Request, res: Response) =>
    handleFacebookCatalogFeedRequest(req, res, String(req.query.format || '').toLowerCase() === 'csv' ? 'csv' : 'xml')
  );
  app.get(['/api/facebook-feed.csv', '/api/facebook-catalog.csv'], (req: Request, res: Response) =>
    handleFacebookCatalogFeedRequest(req, res, 'csv')
  );

  // Steadfast Courier, Pathao Courier & Direct Customer Fraud/Delivery Ratio Proxy Handler
  const handleCourierApi = async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const action = String(body.action || req.query.action || '').trim();

      const biz = (Array.isArray(db.businesses) && db.businesses[0]) ? db.businesses[0] : ({} as any);

      const sfApiKey = String(body.steadfastApiKey ?? biz.steadfastApiKey ?? '').trim();
      const sfSecretKey = String(body.steadfastSecretKey ?? biz.steadfastSecretKey ?? '').trim();
      const sfEmail = String(body.steadfastAuthEmail ?? biz.steadfastAuthEmail ?? '').trim();
      const sfPassword = String(body.steadfastAuthPassword ?? biz.steadfastAuthPassword ?? '').trim();

      const pathaoSandbox = Boolean(body.pathaoSandbox ?? biz.pathaoSandbox ?? false);
      const pathaoBaseUrl = pathaoSandbox
        ? 'https://courier-api-sandbox.pathao.com'
        : 'https://api-hermes.pathao.com';
      const pathaoClientId = String(body.pathaoClientId ?? biz.pathaoClientId ?? '').trim();
      const pathaoClientSecret = String(body.pathaoClientSecret ?? biz.pathaoClientSecret ?? '').trim();
      const pathaoUsername = String(body.pathaoUsername ?? biz.pathaoUsername ?? '').trim();
      const pathaoPassword = String(body.pathaoPassword ?? biz.pathaoPassword ?? '').trim();
      const pathaoStoreId = String(body.pathaoStoreId ?? biz.pathaoStoreId ?? '').trim();
      const bdcourierApiKey = String(body.bdcourierApiKey ?? biz.bdcourierApiKey ?? '').trim();

      const issuePathaoToken = async (): Promise<{ token: string | null; error?: string }> => {
        if (!pathaoClientId || !pathaoClientSecret || !pathaoUsername || !pathaoPassword) {
          return {
            token: null,
            error: 'Pathao Client ID, Client Secret, Username (Email) এবং Password দেওয়া হয়নি।'
          };
        }
        try {
          const tokenRes = await fetch(`${pathaoBaseUrl}/aladdin/api/v1/issue-token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({
              client_id: pathaoClientId,
              client_secret: pathaoClientSecret,
              username: pathaoUsername,
              password: pathaoPassword,
              grant_type: 'password'
            })
          });
          const tokenData: any = await tokenRes.json().catch(() => null);
          if (tokenRes.ok && tokenData?.access_token) {
            return { token: String(tokenData.access_token) };
          }
          return {
            token: null,
            error: tokenData?.message || `Pathao টোকেন পাওয়া যায়নি (HTTP ${tokenRes.status})`
          };
        } catch (err: any) {
          return { token: null, error: err?.message || 'Pathao সার্ভারে সংযোগ দেওয়া যায়নি' };
        }
      };

      // 1. Steadfast Balance & Connection Check
      if (action === 'steadfast_balance') {
        if (!sfApiKey || !sfSecretKey) {
          return res.json({
            ok: false,
            message: 'Steadfast Api-Key এবং Secret-Key আবশ্যক।'
          });
        }
        const sfRes = await fetch('https://portal.packzy.com/api/v1/get_balance', {
          method: 'GET',
          headers: {
            'Api-Key': sfApiKey,
            'Secret-Key': sfSecretKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        });
        const sfData: any = await sfRes.json().catch(() => null);
        if (sfRes.ok && sfData && (sfData.status === 200 || sfData.current_balance !== undefined)) {
          return res.json({
            ok: true,
            balance: sfData.current_balance ?? 0,
            message: `Steadfast কানেক্টেড! বর্তমান ব্যালেন্স: ৳${sfData.current_balance ?? 0}`
          });
        }
        return res.json({
          ok: false,
          message: sfData?.message || `Steadfast API রেসপন্স HTTP ${sfRes.status}। আপনার Api-Key ও Secret-Key যাচাই করুন।`
        });
      }

      // 2. Steadfast 1-Click Parcel Booking
      if (action === 'steadfast_create_order') {
        if (!sfApiKey || !sfSecretKey) {
          return res.json({
            ok: false,
            message: 'Steadfast Api-Key এবং Secret-Key সেটআপ করা নেই। Courier Integration সেটিংস থেকে কী বসান।'
          });
        }
        const payload = {
          invoice: String(body.invoice || '').trim(),
          recipient_name: String(body.recipient_name || 'Customer').trim(),
          recipient_phone: String(body.recipient_phone || '').trim(),
          recipient_address: String(body.recipient_address || 'Dhaka, Bangladesh').trim(),
          cod_amount: Math.max(0, Math.round(Number(body.cod_amount || 0))),
          note: String(body.note || '').trim()
        };
        const sfRes = await fetch('https://portal.packzy.com/api/v1/create_order', {
          method: 'POST',
          headers: {
            'Api-Key': sfApiKey,
            'Secret-Key': sfSecretKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(payload)
        });
        const sfData: any = await sfRes.json().catch(() => null);
        if (sfRes.ok && sfData && sfData.status === 200 && sfData.consignment) {
          const c = sfData.consignment;
          return res.json({
            ok: true,
            consignmentId: String(c.consignment_id || ''),
            trackingCode: String(c.tracking_code || c.consignment_id || ''),
            status: String(c.status || 'in_review'),
            message: `Steadfast-এ পার্সেল বুকিং সফল! Consignment ID: ${c.consignment_id}`,
            raw: sfData
          });
        }
        const errMsg =
          sfData?.errors
            ? Object.values(sfData.errors).flat().join(', ')
            : sfData?.message || `Steadfast বুকিং ব্যর্থ (HTTP ${sfRes.status})`;
        return res.json({
          ok: false,
          message: String(errMsg),
          raw: sfData
        });
      }

      // 3. Steadfast Parcel Live Status Check
      if (action === 'steadfast_status') {
        if (!sfApiKey || !sfSecretKey) {
          return res.json({
            ok: false,
            message: 'Steadfast Api-Key এবং Secret-Key আবশ্যক।'
          });
        }
        const cid = String(body.consignmentId || '').trim();
        const trackingCode = String(body.trackingCode || '').trim();
        const invoice = String(body.invoice || '').trim();
        let targetEndpoint = '';
        if (cid) {
          targetEndpoint = `https://portal.packzy.com/api/v1/status_by_cid/${encodeURIComponent(cid)}`;
        } else if (trackingCode) {
          targetEndpoint = `https://portal.packzy.com/api/v1/status_by_trackingcode/${encodeURIComponent(trackingCode)}`;
        } else if (invoice) {
          targetEndpoint = `https://portal.packzy.com/api/v1/status_by_invoice/${encodeURIComponent(invoice)}`;
        } else {
          return res.json({ ok: false, message: 'Consignment ID অথবা Tracking Code প্রয়োজন।' });
        }

        const sfRes = await fetch(targetEndpoint, {
          method: 'GET',
          headers: {
            'Api-Key': sfApiKey,
            'Secret-Key': sfSecretKey,
            Accept: 'application/json'
          }
        });
        const sfData: any = await sfRes.json().catch(() => null);
        if (sfRes.ok && sfData && sfData.delivery_status) {
          return res.json({
            ok: true,
            deliveryStatus: String(sfData.delivery_status),
            message: `Steadfast বর্তমান স্ট্যাটাস: ${sfData.delivery_status}`,
            raw: sfData
          });
        }
        return res.json({
          ok: false,
          message: sfData?.message || 'Steadfast স্ট্যাটাস লোড করা যায়নি।'
        });
      }

      // 4. Pathao Fetch Stores & Test Token Connection
      if (action === 'pathao_stores') {
        const tokenResult = await issuePathaoToken();
        if (!tokenResult.token) {
          return res.json({
            ok: false,
            stores: [],
            message: tokenResult.error || 'Pathao টোকেন তৈরি ব্যর্থ হয়েছে।'
          });
        }
        const storeRes = await fetch(`${pathaoBaseUrl}/aladdin/api/v1/stores`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        });
        const storeData: any = await storeRes.json().catch(() => null);
        const list = Array.isArray(storeData?.data?.data)
          ? storeData.data.data
          : Array.isArray(storeData?.data)
          ? storeData.data
          : [];
        return res.json({
          ok: true,
          stores: list.map((s: any) => ({
            store_id: String(s.store_id ?? s.id ?? ''),
            store_name: String(s.store_name ?? s.name ?? 'Store'),
            store_address: String(s.store_address ?? '')
          })),
          message: `Pathao কানেক্টেড! ${list.length}টি স্টোর পাওয়া গেছে।`
        });
      }

      // 5. Pathao 1-Click Parcel Booking
      if (action === 'pathao_create_order') {
        const tokenResult = await issuePathaoToken();
        if (!tokenResult.token) {
          return res.json({
            ok: false,
            message: tokenResult.error || 'Pathao API ক্রেডেনশিয়াল সেটআপ করা নেই।'
          });
        }
        const resolvedStoreId = Number(body.store_id || pathaoStoreId || 0);
        if (!resolvedStoreId) {
          return res.json({
            ok: false,
            message: 'Pathao Store ID প্রয়োজন। Courier Integration সেটিংসে গিয়ে "Store লোড করুন" বাটনে ক্লিক করে Store সিলেক্ট করুন।'
          });
        }
        const rawAddress = String(body.recipient_address || 'Dhaka, Bangladesh').trim();
        const paddedAddress = rawAddress.length < 10 ? `${rawAddress}, Dhaka, Bangladesh` : rawAddress;

        const orderPayload: Record<string, any> = {
          store_id: resolvedStoreId,
          merchant_order_id: String(body.merchant_order_id || '').trim(),
          recipient_name: String(body.recipient_name || 'Customer').trim(),
          recipient_phone: String(body.recipient_phone || '').trim(),
          recipient_address: paddedAddress,
          delivery_type: 48,
          item_type: 2,
          special_instruction: String(body.special_instruction || '').trim(),
          item_quantity: Math.max(1, Number(body.item_quantity || 1)),
          item_weight: 0.5,
          amount_to_collect: Math.max(0, Math.round(Number(body.amount_to_collect || 0))),
          item_description: String(body.item_description || 'Online Order Parcel').trim()
        };

        const pRes = await fetch(`${pathaoBaseUrl}/aladdin/api/v1/orders`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenResult.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(orderPayload)
        });
        const pData: any = await pRes.json().catch(() => null);
        if (pRes.ok && pData && (pData.code === 200 || pData.data?.consignment_id)) {
          const cid = String(pData.data?.consignment_id || '');
          return res.json({
            ok: true,
            consignmentId: cid,
            trackingCode: cid,
            status: String(pData.data?.order_status || 'Pending'),
            message: `Pathao-তে পার্সেল বুকিং সফল! Consignment ID: ${cid}`,
            raw: pData
          });
        }
        const errMsg =
          pData?.errors
            ? Object.values(pData.errors).flat().join(', ')
            : pData?.message || `Pathao বুকিং ব্যর্থ (HTTP ${pRes.status})`;
        return res.json({
          ok: false,
          message: String(errMsg),
          raw: pData
        });
      }

      // 6. Direct Customer Fraud & Delivery Ratio Check (Steadfast + Pathao + Optional BDCourier)
      if (action === 'fraud_check') {
        const rawPhone = String(body.phone || '').replace(/\D+/g, '');
        const cleanPhone = rawPhone.startsWith('880') && rawPhone.length === 13
          ? rawPhone.slice(2)
          : rawPhone.length === 10 && rawPhone.startsWith('1')
          ? `0${rawPhone}`
          : rawPhone;

        if (!/^01\d{9}$/.test(cleanPhone)) {
          return res.json({
            ok: false,
            message: 'সঠিক ১১ ডিজিটের মোবাইল নাম্বার দিন (01XXXXXXXXX)।'
          });
        }

        let steadfastStats = {
          provider: 'Steadfast',
          total: 0,
          delivered: 0,
          cancelled: 0,
          successRatio: 0,
          status: 'not_configured' as 'live' | 'not_configured' | 'error',
          message: 'Steadfast ক্রেডেনশিয়াল দেওয়া হয়নি'
        };

        let pathaoStats = {
          provider: 'Pathao',
          total: 0,
          delivered: 0,
          cancelled: 0,
          successRatio: 0,
          status: 'not_configured' as 'live' | 'not_configured' | 'error',
          message: 'Pathao ক্রেডেনশিয়াল দেওয়া হয়নি'
        };

        // Option A: If BDCourier API Key is provided, query BDCourier for multi-courier stats
        if (bdcourierApiKey) {
          try {
            const bdcRes = await fetch(`https://bdcourier.com/api/courier-check?phone=${encodeURIComponent(cleanPhone)}`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${bdcourierApiKey}`,
                Accept: 'application/json'
              }
            });
            const bdcData: any = await bdcRes.json().catch(() => null);
            const cData = bdcData?.courierData || bdcData?.data;
            if (cData) {
              if (cData.steadfast) {
                const del = Number(cData.steadfast.success_parcel ?? cData.steadfast.delivered ?? 0);
                const can = Number(cData.steadfast.cancelled_parcel ?? cData.steadfast.cancelled ?? 0);
                const tot = Number(cData.steadfast.total_parcel ?? (del + can));
                steadfastStats = {
                  provider: 'Steadfast',
                  total: tot,
                  delivered: del,
                  cancelled: can,
                  successRatio: tot > 0 ? Math.round((del / tot) * 100) : 0,
                  status: 'live',
                  message: 'লাইভ ডাটা (Steadfast)'
                };
              }
              if (cData.pathao) {
                const del = Number(cData.pathao.success_parcel ?? cData.pathao.delivered ?? 0);
                const can = Number(cData.pathao.cancelled_parcel ?? cData.pathao.cancelled ?? 0);
                const tot = Number(cData.pathao.total_parcel ?? (del + can));
                pathaoStats = {
                  provider: 'Pathao',
                  total: tot,
                  delivered: del,
                  cancelled: can,
                  successRatio: tot > 0 ? Math.round((del / tot) * 100) : 0,
                  status: 'live',
                  message: 'লাইভ ডাটা (Pathao)'
                };
              }
            }
          } catch {
            // Fall through to direct checks
          }
        }

        // Option B: Direct Pathao Customer Success Rate Check (Free via Pathao Merchant API)
        if (pathaoStats.status !== 'live' && pathaoClientId && pathaoClientSecret && pathaoUsername && pathaoPassword) {
          try {
            const tokenResult = await issuePathaoToken();
            if (tokenResult.token) {
              const pSuccessRes = await fetch(`${pathaoBaseUrl}/aladdin/api/v1/user/success`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${tokenResult.token}`,
                  'Content-Type': 'application/json',
                  Accept: 'application/json'
                },
                body: JSON.stringify({ phone: cleanPhone })
              });
              const pSuccessData: any = await pSuccessRes.json().catch(() => null);
              const customerNode = pSuccessData?.data?.customer || pSuccessData?.data || pSuccessData;
              if (pSuccessRes.ok && customerNode && (customerNode.total_delivery !== undefined || customerNode.successful_delivery !== undefined)) {
                const del = Number(customerNode.successful_delivery ?? 0);
                const tot = Number(customerNode.total_delivery ?? del);
                const can = Math.max(0, tot - del);
                pathaoStats = {
                  provider: 'Pathao',
                  total: tot,
                  delivered: del,
                  cancelled: can,
                  successRatio: tot > 0 ? Math.round((del / tot) * 100) : 0,
                  status: 'live',
                  message: 'Pathao ডাইরেক্ট চেক সম্পন্ন'
                };
              } else {
                pathaoStats = {
                  ...pathaoStats,
                  status: 'live',
                  message: 'Pathao-তে পূর্বে কোনো রেকর্ড পাওয়া যায়নি'
                };
              }
            } else {
              pathaoStats = {
                ...pathaoStats,
                status: 'error',
                message: tokenResult.error || 'Pathao লগইন ব্যর্থ'
              };
            }
          } catch (e: any) {
            pathaoStats = {
              ...pathaoStats,
              status: 'error',
              message: e?.message || 'Pathao চেক ব্যর্থ'
            };
          }
        }

        // Option C: Direct Steadfast Fraud / Delivery Ratio Check (Free via Steadfast Account Email/Password Portal Login OR API)
        if (steadfastStats.status !== 'live' && (sfApiKey || (sfEmail && sfPassword))) {
          try {
            let sfFetched = false;

            // 1. If Steadfast Account Email & Password are provided, perform authenticated portal check at steadfast.com.bd/user/frauds/check/{phone}
            if (sfEmail && sfPassword) {
              try {
                const loginPageRes = await fetch('https://steadfast.com.bd/login', {
                  method: 'GET',
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    Accept: 'text/html,application/xhtml+xml'
                  }
                });
                const loginHtml = await loginPageRes.text();
                const csrfMatch =
                  loginHtml.match(/name="_token"\s+value="([^"]+)"/i) ||
                  loginHtml.match(/content="([^"]+)"\s+name="csrf-token"/i);
                const rawCookies = (loginPageRes.headers as any).getSetCookie
                  ? (loginPageRes.headers as any).getSetCookie()
                  : [loginPageRes.headers.get('set-cookie')].filter(Boolean);
                const cookieHeader = rawCookies
                  .map((c: string) => String(c).split(';')[0])
                  .join('; ');

                if (csrfMatch && csrfMatch[1]) {
                  const formParams = new URLSearchParams({
                    _token: csrfMatch[1],
                    email: sfEmail,
                    password: sfPassword
                  });
                  const authRes = await fetch('https://steadfast.com.bd/login', {
                    method: 'POST',
                    redirect: 'manual',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded',
                      Cookie: cookieHeader,
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    body: formParams.toString()
                  });
                  const authCookies = (authRes.headers as any).getSetCookie
                    ? (authRes.headers as any).getSetCookie()
                    : [authRes.headers.get('set-cookie')].filter(Boolean);
                  const mergedCookie = [
                    ...rawCookies.map((c: string) => String(c).split(';')[0]),
                    ...authCookies.map((c: string) => String(c).split(';')[0])
                  ].join('; ');

                  const fraudRes = await fetch(
                    `https://steadfast.com.bd/user/frauds/check/${encodeURIComponent(cleanPhone)}`,
                    {
                      method: 'GET',
                      headers: {
                        Cookie: mergedCookie,
                        Accept: 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                      }
                    }
                  );
                  const fd: any = await fraudRes.json().catch(() => null);
                  if (fd && (fd.total_delivered !== undefined || fd.total_cancelled !== undefined || fd.total_parcels !== undefined)) {
                    const del = Number(fd.total_delivered ?? 0);
                    const can = Number(fd.total_cancelled ?? 0);
                    const tot = Number(fd.total_parcels ?? (del + can));
                    steadfastStats = {
                      provider: 'Steadfast',
                      total: tot,
                      delivered: del,
                      cancelled: can,
                      successRatio: tot > 0 ? Math.round((del / tot) * 100) : 0,
                      status: 'live',
                      message: 'Steadfast পোর্টাল ডাইরেক্ট চেক সম্পন্ন'
                    };
                    sfFetched = true;
                  }
                }
              } catch {
                // Fall through to API key check
              }
            }

            // 2. Fallback / Direct API Key Check on portal.packzy.com
            if (!sfFetched && sfApiKey && sfSecretKey) {
              const sfFraudUrls = [
                `https://portal.packzy.com/api/v1/fraud_check/${encodeURIComponent(cleanPhone)}`,
                `https://steadfast.com.bd/user/frauds/check/${encodeURIComponent(cleanPhone)}`
              ];
              for (const fUrl of sfFraudUrls) {
                try {
                  const r = await fetch(fUrl, {
                    method: 'GET',
                    headers: {
                      'Api-Key': sfApiKey,
                      'Secret-Key': sfSecretKey,
                      Accept: 'application/json',
                      'X-Requested-With': 'XMLHttpRequest'
                    }
                  });
                  const d: any = await r.json().catch(() => null);
                  if (d && (d.total_delivered !== undefined || d.total_cancelled !== undefined || d.total_parcels !== undefined)) {
                    const del = Number(d.total_delivered ?? 0);
                    const can = Number(d.total_cancelled ?? 0);
                    const tot = Number(d.total_parcels ?? (del + can));
                    steadfastStats = {
                      provider: 'Steadfast',
                      total: tot,
                      delivered: del,
                      cancelled: can,
                      successRatio: tot > 0 ? Math.round((del / tot) * 100) : 0,
                      status: 'live',
                      message: 'Steadfast ডাইরেক্ট চেক সম্পন্ন'
                    };
                    sfFetched = true;
                    break;
                  }
                } catch {
                  // Try next URL
                }
              }
            }
            if (!sfFetched) {
              steadfastStats = {
                ...steadfastStats,
                status: 'live',
                message: 'Steadfast কানেক্টেড (কাস্টমারের পূর্বের রেকর্ড ০)'
              };
            }
          } catch (e: any) {
            steadfastStats = {
              ...steadfastStats,
              status: 'error',
              message: e?.message || 'Steadfast চেক ব্যর্থ'
            };
          }
        }

        return res.json({
          ok: true,
          phone: cleanPhone,
          steadfast: steadfastStats,
          pathao: pathaoStats
        });
      }

      return res.status(400).json({ ok: false, message: `Unknown courier action: ${action}` });
    } catch (err: any) {
      return res.status(500).json({
        ok: false,
        message: err?.message || 'Courier API proxy error'
      });
    }
  };

  // Secret Webhook Receiver for Steadfast & Pathao Live Status Updates
  const handleCourierWebhook = (req: Request, res: Response) => {
    try {
      const biz = (Array.isArray(db.businesses) && db.businesses[0]) ? db.businesses[0] : ({} as any);
      const expectedSfToken = String(biz.steadfastWebhookToken || '').trim();
      const expectedPathaoToken = String(biz.pathaoWebhookToken || '').trim();

      const authHeader = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const queryToken = String(req.query.token || req.headers['x-webhook-token'] || '').trim();
      const providedToken = authHeader || queryToken;

      const payload = req.body || {};
      const cid = String(payload.consignment_id || payload.consignmentId || '').trim();
      const invoice = String(payload.invoice || payload.merchant_order_id || '').trim();
      const rawStatus = String(payload.status || payload.order_status || payload.event || '').toLowerCase().trim();

      if (!cid && !invoice) {
        return res.status(200).json({ status: 'success', message: 'Webhook endpoint active & ready' });
      }

      // Enforce Webhook Token Verification whenever a token is configured in Courier Integration
      if (expectedSfToken || expectedPathaoToken) {
        const validSf = expectedSfToken && providedToken === expectedSfToken;
        const validPathao = expectedPathaoToken && providedToken === expectedPathaoToken;
        if (!validSf && !validPathao) {
          return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid or missing webhook token' });
        }
      }

      let updatedOrderNo = '';
      if (Array.isArray(db.onlineOrders)) {
        db.onlineOrders = db.onlineOrders.map((ord: any) => {
          const matchesCid = cid && String(ord.courierConsignmentId || '') === cid;
          const matchesInv =
            invoice &&
            (String(ord.orderNo || '') === invoice || String(ord.invoiceNo || '') === invoice);
          if (!matchesCid && !matchesInv) return ord;

          updatedOrderNo = ord.orderNo;
          let nextOrderStatus = ord.orderStatus;
          let nextPaymentStatus = ord.paymentStatus;

          if (rawStatus.includes('deliver') && !rawStatus.includes('un') && !rawStatus.includes('cancel')) {
            nextOrderStatus = 'delivered';
            nextPaymentStatus = 'paid';
          } else if (rawStatus.includes('cancel') || rawStatus.includes('return')) {
            nextOrderStatus = 'cancelled';
          } else if (rawStatus.includes('transit') || rawStatus.includes('pick') || rawStatus.includes('dispatch')) {
            nextOrderStatus = 'dispatched';
          }

          return {
            ...ord,
            courierStatus: rawStatus || ord.courierStatus,
            orderStatus: nextOrderStatus,
            paymentStatus: nextPaymentStatus,
            updatedAt: new Date().toISOString()
          };
        });

        if (updatedOrderNo) {
          db.updatedAt = Date.now();
          saveDbToDisk();
        }
      }

      return res.status(200).json({
        status: 'success',
        updatedOrderNo: updatedOrderNo || null,
        message: updatedOrderNo
          ? `Order ${updatedOrderNo} updated via webhook to ${rawStatus}`
          : 'Webhook received'
      });
    } catch (err: any) {
      return res.status(500).json({ status: 'error', message: err?.message || 'Webhook error' });
    }
  };

  app.post('/api/courier', handleCourierApi);
  app.all('/api/courier-webhook', handleCourierWebhook);

  // Dual SMS Gateway (Alpha SMS https://api.sms.net.bd & GreenWeb https://api.bdbulksms.net) Server-Side Proxy Handlers
  const handleSmsSend = async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const savedBiz = Array.isArray(db.businesses) && db.businesses[0] ? db.businesses[0] : ({} as any);
      const provider =
        String(body.provider || req.query.provider || savedBiz.smsProvider || 'alpha')
          .trim()
          .toLowerCase() === 'greenweb'
          ? 'greenweb'
          : 'alpha';

      const msg = String(body.msg ?? req.query.msg ?? '').trim();
      const to = String(body.to ?? req.query.to ?? '').trim();

      if (!msg || !to) {
        return res.status(400).json({ error: 400, msg: 'msg and to are required' });
      }

      if (provider === 'greenweb') {
        const token = String(body.token || body.api_key || req.query.token || savedBiz.greenwebToken || '').trim();
        if (!token) {
          return res.status(400).json({ error: 400, msg: 'GreenWeb token is required' });
        }

        const formParams = new URLSearchParams({
          token,
          to,
          message: msg
        });

        const gwRes = await fetch('https://api.bdbulksms.net/api.php?json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formParams.toString()
        });
        const rawText = await gwRes.text();
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }

        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0] || {};
          const statusStr = String(first.status || '').toUpperCase();
          const responseMsg = String(first.response || first.status || 'GreenWeb response');
          const isOk =
            statusStr === 'SENT' ||
            statusStr === 'SUCCESS' ||
            responseMsg.toLowerCase().includes('successfully');
          return res.json({
            error: isOk ? 0 : 1,
            msg: responseMsg,
            provider: 'greenweb',
            data: {
              request_id: isOk ? `GW-${Date.now().toString().slice(-6)}` : 0,
              raw: parsed
            }
          });
        }

        const isTextOk =
          rawText.toLowerCase().includes('ok:') ||
          rawText.toLowerCase().includes('successfully') ||
          rawText.toLowerCase().includes('"status":"sent"');
        return res.json({
          error: isTextOk ? 0 : 1,
          msg: rawText.trim() || (isTextOk ? 'GreenWeb SMS Sent' : 'GreenWeb SMS Failed'),
          provider: 'greenweb',
          data: {
            request_id: isTextOk ? `GW-${Date.now().toString().slice(-6)}` : 0
          }
        });
      }

      // Default: Alpha SMS (api.sms.net.bd)
      const apiKey = String(body.api_key || req.query.api_key || savedBiz.smsApiKey || '').trim();
      const senderId = String(body.sender_id ?? req.query.sender_id ?? savedBiz.smsSenderId ?? '').trim();
      const schedule = String(body.schedule ?? req.query.schedule ?? '').trim();
      const contentId = String(body.content_id ?? req.query.content_id ?? savedBiz.smsContentId ?? '').trim();

      if (!apiKey) {
        return res.status(400).json({ error: 400, msg: 'api_key is required' });
      }

      const params = new URLSearchParams({
        api_key: apiKey,
        msg,
        to
      });
      if (senderId) params.set('sender_id', senderId);
      if (schedule) params.set('schedule', schedule);
      if (contentId) params.set('content_id', contentId);

      const response = await fetch(`https://api.sms.net.bd/sendsms?${params.toString()}`);
      const data = await response.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({
        error: 500,
        msg: err?.message || 'Failed to connect to SMS gateway'
      });
    }
  };

  const handleSmsBalance = async (req: Request, res: Response) => {
    try {
      const savedBiz = Array.isArray(db.businesses) && db.businesses[0] ? db.businesses[0] : ({} as any);
      const provider =
        String(req.query.provider || req.body?.provider || savedBiz.smsProvider || 'alpha')
          .trim()
          .toLowerCase() === 'greenweb'
          ? 'greenweb'
          : 'alpha';

      if (provider === 'greenweb') {
        const token = String(
          req.query.token || req.query.api_key || req.body?.token || savedBiz.greenwebToken || ''
        ).trim();
        if (!token) {
          return res.status(400).json({ error: 400, msg: 'GreenWeb token is required' });
        }
        const gwRes = await fetch(
          `https://api.bdbulksms.net/g_api.php?token=${encodeURIComponent(token)}&balance&expiry&json`
        );
        const rawText = await gwRes.text();
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }

        if (Array.isArray(parsed)) {
          const balNode = parsed.find((item: any) => item && item.balance !== undefined);
          const expNode = parsed.find((item: any) => item && item.expiry !== undefined);
          if (balNode) {
            return res.json({
              error: 0,
              msg: 'OK',
              provider: 'greenweb',
              data: {
                balance: String(balNode.balance ?? '0'),
                expiry: expNode?.expiry ? String(expNode.expiry) : undefined
              }
            });
          }
        }
        if (parsed && typeof parsed === 'object' && parsed.balance !== undefined) {
          return res.json({
            error: 0,
            msg: 'OK',
            provider: 'greenweb',
            data: { balance: String(parsed.balance) }
          });
        }
        if (rawText.trim() && !rawText.toLowerCase().includes('error') && !rawText.toLowerCase().includes('invalid')) {
          return res.json({
            error: 0,
            msg: 'OK',
            provider: 'greenweb',
            data: { balance: rawText.trim() }
          });
        }
        return res.json({
          error: 1,
          msg: rawText.trim() || 'GreenWeb ব্যালেন্স পাওয়া যায়নি (সঠিক Token চেক করুন)',
          provider: 'greenweb'
        });
      }

      const apiKey = String(req.query.api_key || req.body?.api_key || savedBiz.smsApiKey || '').trim();
      if (!apiKey) {
        return res.status(400).json({ error: 400, msg: 'api_key is required' });
      }
      const response = await fetch(
        `https://api.sms.net.bd/user/balance/?api_key=${encodeURIComponent(apiKey)}`
      );
      const data = await response.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({
        error: 500,
        msg: err?.message || 'Failed to check SMS balance'
      });
    }
  };

  app.all('/api/index.php', (req: Request, res: Response) => {
    const route = String(req.query.route || '').replace(/^\/+|\/+$/g, '');
    if (route === 'state') {
      if (req.method === 'GET') return handleGetState(req, res);
      if (req.method === 'POST') return handlePostState(req, res);
    }
    if (route === 'sms/send') {
      return handleSmsSend(req, res);
    }
    if (route === 'sms/balance') {
      return handleSmsBalance(req, res);
    }
    if (route === 'upload-image') {
      if (req.method === 'POST') return handleUploadImage(req, res);
    }
    if (route === 'clear-cache') {
      return handleClearCache(req, res);
    }
    if (route === 'product-image') {
      return handleProductImageRequest(req, res);
    }
    if (
      route === 'facebook-feed.xml' ||
      route === 'facebook-catalog.xml' ||
      ((route === 'facebook-feed' || route === 'facebook-catalog') && req.query.format !== 'csv')
    ) {
      return handleFacebookCatalogFeedRequest(req, res, 'xml');
    }
    if (
      route === 'facebook-feed.csv' ||
      route === 'facebook-catalog.csv' ||
      ((route === 'facebook-feed' || route === 'facebook-catalog') && req.query.format === 'csv')
    ) {
      return handleFacebookCatalogFeedRequest(req, res, 'csv');
    }
    if (route === 'order-limit-check') {
      return handleOrderLimitCheck(req, res);
    }
    if (route === 'order-telemetry' || route === 'fb/capi' || route === 'fb-capi') {
      if (req.method === 'POST') return handleFacebookCapi(req, res);
    }
    if (route === 'wp-sync-order') {
      if (req.method === 'POST') return handleWordPressOrderSync(req, res);
    }
    if (route === 'courier') {
      return handleCourierApi(req, res);
    }
    if (route === 'courier-webhook') {
      return handleCourierWebhook(req, res);
    }
    if (route === 'auth/login') {
      return handleAuthLogin(req, res);
    }
    if (route === 'auth/session-token') {
      return handleAuthSessionToken(req, res);
    }
    if (route === 'auth/logout') {
      return handleAuthLogout(req, res);
    }
    if (route === 'download-cpanel-zip' || route === 'download-source-zip' || route === 'project-file') {
      if (!requireAdminDownloadAuthTs(req, res)) return;
    }
    return res.json({ success: true, data: req.body || {} });
  });

  function handleAuthLogin(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    const identifier = String(req.body?.username || req.body?.identifier || '').trim().toLowerCase();
    const rawPassword = String(req.body?.password || '');
    if (!identifier || !rawPassword) {
      return res.status(400).json({
        success: false,
        error: 'ইউজারনেম এবং পাসওয়ার্ড প্রদান করা আবশ্যক।'
      });
    }

    db.users = mergeAndHashUsersTs(initialUsers, Array.isArray(db.users) ? db.users : []);
    const matchedUser = db.users.find((u: any) => {
      if (!u || u.isActive === false) return false;
      const uname = String(u.username || '').trim().toLowerCase();
      const email = String(u.email || '').trim().toLowerCase();
      const altEmail = email.includes('@stockflowbd.com')
        ? email.replace('@stockflowbd.com', '@stockmasterbd.com')
        : email.includes('@stockmasterbd.com')
        ? email.replace('@stockmasterbd.com', '@stockflowbd.com')
        : '';
      return uname === identifier || email === identifier || (Boolean(altEmail) && altEmail === identifier);
    });

    if (!matchedUser) {
      return res.status(401).json({
        success: false,
        error: 'ভুল ইউজারনেম অথবা পাসওয়ার্ড! অনুগ্রহ করে সঠিক তথ্য দিন।'
      });
    }

    const storedHash = String(
      matchedUser.passwordHash || matchedUser.password_hash || matchedUser.password || ''
    ).trim();
    if (!verifyUserPasswordTs(rawPassword, storedHash)) {
      return res.status(401).json({
        success: false,
        error: 'ভুল ইউজারনেম অথবা পাসওয়ার্ড! অনুগ্রহ করে সঠিক তথ্য দিন।'
      });
    }

    matchedUser.lastLoginAt = new Date().toLocaleString('bn-BD');
    saveDbToDisk();

    const [safeUser] = stripUserPasswordsForClientTs([matchedUser]);
    const signedToken = createAdminSessionTokenTs(
      String(matchedUser.id || 'user_01'),
      String(matchedUser.role || 'super_admin')
    );
    res.setHeader(
      'Set-Cookie',
      `sm_admin_sid=${encodeURIComponent(signedToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
    );
    return res.json({
      success: true,
      csrf_token: signedToken,
      user: safeUser
    });
  }

  function handleAuthSessionToken(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    if (!verifyAdminDownloadAuthTs(req)) {
      return res.status(401).json({
        success: false,
        error: 'অনুমোদিত নয়! বৈধ অ্যাডমিন টোকেন ছাড়া সেশন সিঙ্ক করা যাবে না। (401 Unauthorized)'
      });
    }
    const userId = String(req.body?.userId || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    db.users = mergeAndHashUsersTs(initialUsers, Array.isArray(db.users) ? db.users : []);
    const matchedUser = db.users.find(
      (u: any) =>
        u &&
        u.isActive !== false &&
        (String(u.id || '') === userId || (email && String(u.email || '').trim().toLowerCase() === email))
    );
    if (!matchedUser) {
      return res.status(401).json({ success: false, error: 'Invalid admin session user' });
    }
    const signedToken = createAdminSessionTokenTs(
      String(matchedUser.id || 'user_01'),
      String(matchedUser.role || 'super_admin')
    );
    res.setHeader(
      'Set-Cookie',
      `sm_admin_sid=${encodeURIComponent(signedToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
    );
    return res.json({
      success: true,
      csrf_token: signedToken
    });
  }

  function handleAuthLogout(req: Request, res: Response) {
    const tok = extractAdminTokenFromReqTs(req);
    if (tok) {
      revokedAdminTokens.add(tok);
    }
    res.setHeader('Set-Cookie', 'sm_admin_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return res.json({
      success: true,
      message: 'Logged out successfully'
    });
  }

  app.post('/api/auth/login', handleAuthLogin);
  app.post('/api/auth/session-token', handleAuthSessionToken);
  app.post('/api/auth/logout', handleAuthLogout);

  app.get('/api/products', (req: Request, res: Response) => {
    res.json({ success: true, data: db.products });
  });

  app.post('/api/products', (req: Request, res: Response) => {
    const newProduct = {
      ...req.body,
      id: req.body.id || `prod_${Date.now()}`
    };
    if (!db.products.some((p: any) => p.id === newProduct.id)) {
      db.products.unshift(newProduct);
      db.updatedAt = Date.now();
      saveDbToDisk();
    }
    res.status(201).json({ success: true, data: newProduct });
  });

  app.get('/api/sales', (req: Request, res: Response) => {
    res.json({ success: true, data: db.sales });
  });

  app.post('/api/sales', (req: Request, res: Response) => {
    const sale = {
      ...req.body,
      id: req.body.id || `sale_${Date.now()}`,
      createdAt: req.body.createdAt || new Date().toISOString()
    };
    if (!db.sales.some((s: any) => s.id === sale.id)) {
      db.sales.unshift(sale);
      db.updatedAt = Date.now();
      saveDbToDisk();
    }
    res.status(201).json({ success: true, data: sale });
  });

  app.get('/api/purchases', (req: Request, res: Response) => {
    res.json({ success: true, data: db.purchases });
  });

  app.post('/api/purchases', (req: Request, res: Response) => {
    const purchase = {
      ...req.body,
      id: req.body.id || `pur_${Date.now()}`,
      receivedDate: req.body.receivedDate || new Date().toISOString().split('T')[0]
    };
    if (!db.purchases.some((p: any) => p.id === purchase.id)) {
      db.purchases.unshift(purchase);
      db.updatedAt = Date.now();
      saveDbToDisk();
    }
    res.status(201).json({ success: true, data: purchase });
  });

  app.post('/api/sms/send', handleSmsSend);
  app.get('/api/sms/balance', handleSmsBalance);

  app.get('/api/sms/report/:id', async (req: Request, res: Response) => {
    try {
      const requestId = String(req.params.id || '').trim();
      const savedBiz = Array.isArray(db.businesses) && db.businesses[0] ? db.businesses[0] : ({} as any);
      const apiKey = String(req.query.api_key || savedBiz.smsApiKey || '').trim();
      if (!apiKey || !requestId) {
        return res.status(400).json({ error: 400, msg: 'api_key and request id are required' });
      }
      const response = await fetch(
        `https://api.sms.net.bd/report/request/${encodeURIComponent(requestId)}/?api_key=${encodeURIComponent(apiKey)}`
      );
      const data = await response.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({
        error: 500,
        msg: err?.message || 'Failed to fetch SMS report from api.sms.net.bd'
      });
    }
  });

  // Serve physical uploaded images (/uploads/products/* and /uploads/logos/*) with 1-year browser cache
  app.use(
    '/uploads',
    express.static(UPLOADS_ROOT_DIR, {
      maxAge: '365d',
      immutable: true,
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
    })
  );

  // Rewrite nested SPA path requests for /uploads/* or /assets/* (e.g. /landing/uploads/* or /product/assets/*)
  app.get(/^\/.+\/uploads\/(.+)$/, (req: Request, res: Response) => {
    const subPath = String(req.params[0] || '').replace(/\.\./g, '');
    const targetPath = path.join(UPLOADS_ROOT_DIR, subPath);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      res.sendFile(targetPath, (err) => {
        if (err && !res.headersSent) res.status(404).end();
      });
    } else {
      res.status(404).end();
    }
  });

  // Always serve compiled production bundles (/assets/app.bundle.js & /assets/app.bundle.css) with CORS enabled
  // so cPanel index.php auto-provisioning and browser fallback work in both dev and prod modes
  app.use(
    '/assets',
    express.static(path.join(__dirname, 'assets'), {
      maxAge: '365d',
      setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
    })
  );
  app.use(
    '/assets',
    express.static(path.join(__dirname, 'dist', 'assets'), {
      maxAge: '365d',
      setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      }
    })
  );

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { entries: ['index.html'] },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.get(/^\/.+\/assets\/(.+)$/, (req: Request, res: Response) => {
      const subPath = String(req.params[0] || '').replace(/\.\./g, '');
      const distAssetPath = path.join(__dirname, 'dist', 'assets', subPath);
      const rootAssetPath = path.join(__dirname, 'assets', subPath);
      const targetPath =
        fs.existsSync(distAssetPath) && fs.statSync(distAssetPath).isFile()
          ? distAssetPath
          : rootAssetPath;
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        res.sendFile(targetPath, (err) => {
          if (err && !res.headersSent) res.status(404).end();
        });
      } else {
        res.status(404).end();
      }
    });
    app.use(express.static(path.join(__dirname, 'dist'), { maxAge: '7d' }));
    app.get('*', (req: Request, res: Response) => {
      const distIndex = path.join(__dirname, 'dist', 'index.html');
      const standaloneRootHtml = path.join(__dirname, 'cpanel-app.html');
      if (fs.existsSync(distIndex)) {
        res.sendFile(distIndex);
      } else if (fs.existsSync(standaloneRootHtml)) {
        res.sendFile(standaloneRootHtml);
      } else {
        res.sendFile(path.join(__dirname, 'index.html'));
      }
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[StockMaster BD Preview Server] running at http://0.0.0.0:${PORT}`);
  });

  server.on('error', (err: any) => {
    console.error('[StockMaster BD Server Error]:', err?.message || err);
  });
}

process.on('uncaughtException', (err) => {
  console.error('[StockMaster BD Uncaught Exception]:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[StockMaster BD Unhandled Rejection]:', reason);
});

startServer().catch((err) => {
  console.error('[StockMaster BD Fatal Startup Error]:', err);
});

