// StockMaster BD - Universal Node.js Entry File for Hostinger / Coolify / VPS
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
await import('./server.ts');
