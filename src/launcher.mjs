/** Public demo launch contract already used by Shisetsu-Code/Hybrid-actions. */
export function demoLaunchUrl(target) {
  if (!target.requiresLauncher) return target.url;
  if (target.provider !== 'pragmatic' || !/^vs[a-z0-9]+$/i.test(target.symbol || '')) throw new Error('Unsupported or unidentified demo launcher');
  const source = new URL(target.url);
  if (source.origin !== 'https://www.pragmaticplay.com' || !source.pathname.startsWith('/en/games/')) throw new Error('Expected the official Pragmatic catalogue entry');
  const query = new URLSearchParams({ gameSymbol: target.symbol, websiteUrl: 'https://demogamesfree.pragmaticplay.net', jurisdiction: '99', lobby_url: target.url, lang: 'en', cur: 'USD' });
  return 'https://demogamesfree.pragmaticplay.net/gs2c/openGame.do?' + query;
}
