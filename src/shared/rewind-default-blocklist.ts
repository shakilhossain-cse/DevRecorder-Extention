// cspell:disable
// Built-in default blocklist for Share Last Minute / Instant Replay.
//
// These hosts are blocked out-of-the-box because they typically contain
// sensitive personal, financial, or proprietary information that users would
// not want auto-captured in a 60-second rolling buffer.
//
// Matching is SUFFIX-based: an entry like "paypal.com" blocks paypal.com and
// every subdomain of it (business.paypal.com, www.paypal.com, etc.). Entries
// that are themselves scoped (e.g. "app.slack.com", "mail.google.com") only
// block that subdomain tree, not the rest of the parent domain.
//
// This list mirrors the defaults jam.dev ships with, adapted to suffix-match
// semantics. The user can override any entry per-site via the popup's
// "Continue" confirmation flow, which adds the host to forceEnabledHosts.

import { normalizeHost } from './rewind-storage';

export const DEFAULT_BLOCKED_HOSTS: readonly string[] = [
  // Banking, payments, cards
  'paypal.com',
  'chase.com',
  'wellsfargo.com',
  'bankofamerica.com',
  'capitalone.com',
  'citi.com',
  'discover.com',
  'americanexpress.com',
  'td.com',
  'syf.com',
  'schwab.com',
  'fidelity.com',
  'ameritrade.com',
  'tdameritrade.com',
  'adyen.com',
  'intuit.com',
  'adp.com',
  'experian.com',
  'creditkarma.com',
  'credit-agricole.fr',
  'hdfcbank.com',
  'sberbank.ru',
  'poste.it',
  'rakuten-sec.co.jp',
  'rakuten-card.co.jp',
  'sbisec.co.jp',
  'bancoestado.cl',
  'onlinesbi.com',
  'na3.netchexonline.net',

  // Crypto, trading, markets
  'coinmarketcap.com',
  'coingecko.com',
  'tradingview.com',
  'binance.com',
  'coinbase.com',
  'etoro.com',
  'opensea.io',
  'bscscan.com',
  'investing.com',
  'moneycontrol.com',
  'marketwatch.com',
  'investopedia.com',
  'zerodha.com',
  'doviz.com',
  'foxbusiness.com',
  'fool.com',
  'alipay.com',
  'altin.in',
  'toyokeizai.net',

  // Personal portals and reviews
  'yahoo.co.jp',
  'trustpilot.com',

  // Productivity, work, collaboration
  'docs.google.com',
  'mail.google.com',
  'meet.google.com',
  'calendar.google.com',
  'drive.google.com',
  'cloud.google.com',
  'figma.com',
  'app.slack.com',
  'teams.microsoft.com',
  'outlook.office.com',
  'github.com',
  'app.clickup.com',
  'trello.com',
  'atlassian.net',
  'pipedrive.com',
  'desk.zoho.com',
  'vercel.com',
  'aws.amazon.com',
  'app.lawmatics.com',
  'zynksoftware.com',
  'blob-starter.vercel.app',

  // Social
  'instagram.com',
  'linkedin.com',
  'youtube.com',

  // Misc
  'beverlyboy.com',

  // Local development
  'localhost',
];

// Suffix match: returns true if `host` equals an entry or is a subdomain of
// one. Both inputs are run through normalizeHost so "www.paypal.com" matches
// "paypal.com" and casing is irrelevant.
export function isHostDefaultBlocked(host: string): boolean {
  const target = normalizeHost(host);
  if (!target) return false;
  for (const raw of DEFAULT_BLOCKED_HOSTS) {
    const entry = normalizeHost(raw);
    if (!entry) continue;
    if (target === entry) return true;
    if (target.endsWith('.' + entry)) return true;
  }
  return false;
}
