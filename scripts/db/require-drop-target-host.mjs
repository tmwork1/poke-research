// drop 系スクリプト（drop-app-tables.mjs / drop-non-migrations-tables.mjs）の
// 誤実行防止ガード。接続先ホスト名を表示し、環境変数 DROP_TARGET_HOST が
// 完全一致しない限り実行を止める。ホスト名のハードコードによる本番判定は行わない。
export function requireDropTargetHost(databaseUrl) {
  let host;
  try {
    host = new URL(databaseUrl).hostname;
  } catch (e) {
    console.error('DATABASE_URL の解析に失敗しました:', e.message);
    process.exit(1);
  }
  console.log(`接続先ホスト: ${host}`);

  if (process.env.DROP_TARGET_HOST !== host) {
    console.error(
      `破壊的操作のため実行を中止しました（誤って別環境・本番に対して実行することを防ぐガードです）。\n` +
        `このホストに対して実行する意図がある場合は、DROP_TARGET_HOST=${host} を設定して再実行してください。`,
    );
    process.exit(1);
  }
}
