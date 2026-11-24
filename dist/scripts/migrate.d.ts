/**
 * Sinkronisasi struktur tabel & kolom secara 100% NON-DESTRUCTIVE.
 * Dioptimalkan dengan bulk INFORMATION_SCHEMA cache agar startup cepat di TiDB Cloud / remote MySQL.
 */
export declare const ensureDatabaseStructure: (options?: {
    verbose?: boolean;
}) => Promise<void>;
//# sourceMappingURL=migrate.d.ts.map