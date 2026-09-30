// Entry point for the injectable BotGuard bundle.
// Rebuild with:  npm run bundle:botguard
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
globalThis.__BG = { BotGuardClient, WebPoMinter };
