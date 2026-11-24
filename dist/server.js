"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
// ============================================================
//  src/server.ts
//  Entry point — menjalankan server HTTP
// ============================================================
const app_js_1 = __importDefault(require("./app.js"));
const database_js_1 = require("./config/database.js");
const AiSetting_js_1 = __importDefault(require("./models/AiSetting.js"));
const paymentPoller_js_1 = require("./services/paymentPoller.js");
const loggingService_js_1 = require("./services/loggingService.js");
const migrate_js_1 = require("./scripts/migrate.js");
const aiProviderService_js_1 = require("./services/aiProviderService.js");
const PORT = process.env.PORT || 5000;
const startServer = async () => {
    // Tes koneksi database sebelum server mulai menerima request
    await (0, database_js_1.testConnection)();
    // Sinkronisasi struktur tabel & kolom tambahan secara non-destructive
    await (0, migrate_js_1.ensureDatabaseStructure)({ verbose: false });
    console.log('✅ Database tables & incremental columns verified (non-destructive).');
    // Pastikan tabel system_logs dan index siap (§9.2, §14.1)
    await (0, loggingService_js_1.ensureSystemLogsSchema)();
    console.log('✅ System Logs table & indexes synced and ready.');
    // Pastikan tabel ai_settings tersinkronisasi dan memiliki default row (ID = 1)
    await AiSetting_js_1.default.sync();
    await AiSetting_js_1.default.findOrCreate({
        where: { id: 1 },
        defaults: {
            is_auto_reply_active: true,
            provider: null,
            model_name: 'gemini-3.5-flash-lite',
            api_key: '',
            system_prompt: aiProviderService_js_1.DEFAULT_DINOYOCRAFT_SYSTEM_PROMPT,
        },
    });
    console.log('✅ AI Settings table synced and ready.');
    // Background poller pembayaran Midtrans (cadangan sinkronisasi status + auto-expire).
    (0, paymentPoller_js_1.startPaymentPoller)();
    const server = app_js_1.default.listen(Number(PORT), '0.0.0.0', () => {
        console.log('='.repeat(50));
        console.log(`🚀 DinoyoCraft API Server running`);
        console.log(`   Host     : 0.0.0.0 (Accessible from Mobile & Local Network)`);
        console.log(`   Port     : ${PORT}`);
        console.log(`   Env      : ${process.env['NODE_ENV'] ?? 'development'}`);
        console.log(`   Base URL : http://localhost:${PORT}/api`);
        console.log(`   Health   : http://localhost:${PORT}/health`);
        console.log('='.repeat(50));
    });
    server.on('error', (err) => {
        console.error('❌ Server HTTP error:', err);
    });
    let shuttingDown = false;
    const gracefulShutdown = (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.log(`🛑 Received ${signal}, shutting down gracefully...`);
        const forceExitTimer = setTimeout(() => {
            console.warn('⚠️ Shutdown timeout reached, forcing exit.');
            process.exit(1);
        }, 10_000);
        forceExitTimer.unref?.();
        server.close(async () => {
            try {
                await Promise.allSettled([database_js_1.pool.end(), database_js_1.sequelize.close()]);
            }
            finally {
                process.exit(0);
            }
        });
    };
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
};
// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
    (0, loggingService_js_1.logSystemEvent)({
        category: 'system',
        eventName: 'system.unhandled_rejection',
        severity: 'critical',
        outcome: 'failure',
        message: `Unhandled Promise Rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        source: 'backend',
        service: 'api-process',
        error: {
            code: 'UNHANDLED_REJECTION',
            name: reason instanceof Error ? reason.name : 'UnhandledRejection',
            message: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : null,
        },
    }).catch(() => { });
});
// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err);
    (0, loggingService_js_1.logSystemEvent)({
        category: 'system',
        eventName: 'system.uncaught_exception',
        severity: 'critical',
        outcome: 'failure',
        message: `Uncaught Exception: ${err.message}`,
        source: 'backend',
        service: 'api-process',
        error: {
            code: 'UNCAUGHT_EXCEPTION',
            name: err.name,
            message: err.message,
            stack: err.stack || null,
        },
    }).catch(() => { });
});
process.on('exit', (code) => {
    console.log(`🛑 Node process exited with code: ${code}`);
});
startServer().catch((err) => {
    console.error('❌ Gagal menjalankan server:', err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map