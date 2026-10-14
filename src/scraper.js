import crypto from 'node:crypto';

/**
 * Solve ByteDance SlardarWAF proof-of-work challenge
 * @param {string} cs Base64-encoded challenge string
 * @returns {string} Base64-encoded solved cookie value
 */
export function solveWafChallenge(cs) {
  const c = JSON.parse(Buffer.from(cs, 'base64').toString());
  const prefix = Uint8Array.from(Buffer.from(c.v.a, 'base64'));
  const expect = Buffer.from(c.v.c, 'base64').toString('hex');

  for (let i = 0; i < 1_000_000; i++) {
    const sha = crypto.createHash('sha256');
    sha.update(prefix);
    sha.update(i.toString());
    if (sha.digest('hex') === expect) {
      c.d = Buffer.from(i.toString()).toString('base64');
      break;
    }
  }

  return Buffer.from(JSON.stringify(c)).toString('base64');
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0'
];

/**
 * Fetch direct TikTok profile via WAF challenge solver (Layer 2 Fallback)
 * @param {string} cleanUser Clean username without @
 */
export async function getDirectTikTokProfile(cleanUser) {
  const targetUrl = `https://www.tiktok.com/@${cleanUser}`;
  const headers = {
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8'
  };

  try {
    let res = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(9000) });
    let html = await res.text();

    if (html.includes('class="_wafchallengeid"')) {
      const csMatch = html.match(/<p id="cs" class="([^"]+)"/);
      if (csMatch && csMatch[1]) {
        const solvedCookie = solveWafChallenge(csMatch[1]);
        res = await fetch(targetUrl, {
          headers: {
            ...headers,
            'Cookie': `_wafchallengeid=${solvedCookie};`
          },
          signal: AbortSignal.timeout(9000)
        });
        html = await res.text();
      }
    }

    const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match || !match[1]) {
      return { success: false, error: 'Could not extract profile data' };
    }

    const data = JSON.parse(match[1]);
    const userDetail = data['__DEFAULT_SCOPE__']?.['webapp.user-detail'];
    if (!userDetail || userDetail.isError || userDetail.statusCode === 10221) {
      return { success: false, isNotFound: true, error: `Username TikTok @${cleanUser} tidak ditemukan.` };
    }

    const user = userDetail.userInfo?.user || {};
    const stats = userDetail.userInfo?.stats || {};

    return {
      success: true,
      fromDirectProfile: true,
      videoCount: stats.videoCount || 0,
      user: {
        nickname: user.nickname || cleanUser,
        uniqueId: user.uniqueId || cleanUser,
        avatar: user.avatarThumb || user.avatarMedium || '',
        signature: user.signature || ''
      },
      videos: []
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetch TikTok user data and recent videos via embed state with direct profile fallback
 * @param {string} username TikTok username (with or without @)
 * @param {number} maxRetries Maximum retry attempts on transient block
 */
export async function getTikTokUserVideos(username, maxRetries = 2) {
  const cleanUser = username.replace(/^@/, '').trim();
  const handle = `@${cleanUser}`;
  const path = `/embed/${handle}`;
  const targetUrl = `https://www.tiktok.com${path}?refer=creator_embed`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ua = USER_AGENTS[(attempt + Math.floor(Math.random() * USER_AGENTS.length)) % USER_AGENTS.length];
    const headers = {
      'User-Agent': ua,
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      'Referer': 'https://www.tiktok.com/',
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site'
    };

    try {
      if (attempt > 0) {
        // Exponential backoff with random jitter to clear TikTok overload-protect
        const backoffMs = 2500 * attempt + Math.floor(Math.random() * 1500);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      let res = await fetch(targetUrl, { 
        headers, 
        signal: AbortSignal.timeout(9000) 
      });
      let html = await res.text();

      // Check if TikTok Envoy overload protect or 429 was triggered
      if (res.status === 503 || res.status === 429 || html.includes('overload-protect')) {
        if (attempt < maxRetries) continue;
        // Fallback to Layer 2 Direct Profile WAF
        const direct = await getDirectTikTokProfile(cleanUser);
        if (direct.success) {
          return direct;
        }
        return {
          success: false,
          error: `TikTok overload-protect / rate limit triggered for @${cleanUser}. (Status: ${res.status})`
        };
      }

      // Check for Slardar WAF challenge
      if (html.includes('class="_wafchallengeid"')) {
        const csMatch = html.match(/<p id="cs" class="([^"]+)"/);
        if (csMatch && csMatch[1]) {
          const solvedCookie = solveWafChallenge(csMatch[1]);
          res = await fetch(targetUrl, {
            headers: {
              ...headers,
              'Cookie': `_wafchallengeid=${solvedCookie};`
            },
            signal: AbortSignal.timeout(9000)
          });
          html = await res.text();
        }
      }

      const match = html.match(
        /<script id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/
      );

      if (!match || !match[1]) {
        if (attempt < maxRetries) continue;
        // Fallback to Layer 2 Direct Profile WAF
        const direct = await getDirectTikTokProfile(cleanUser);
        if (direct.success) {
          return direct;
        }
        return {
          success: false,
          error: `Could not find __FRONTITY_CONNECT_STATE__ for @${cleanUser}. (Status: ${res.status})`
        };
      }

      const state = JSON.parse(match[1]);
      const embedPath = `/embed/@${cleanUser}`;
      const directPath = `/@${cleanUser}`;
      const data = state?.source?.data?.[embedPath] || state?.source?.data?.[directPath];

      if (!data || data.isError || data.errorCode === 10221 || data.pageName === 'error') {
        return {
          success: false,
          isNotFound: true,
          error: `Username TikTok @${cleanUser} tidak ditemukan (Akun tidak ada atau salah ejaan).`
        };
      }

      const userInfo = data.userInfo || {};
      const rawVideos = data.videoList || [];

      const videos = rawVideos.map((v) => {
        // TikTok snowflake ID: high 32 bits represent Unix timestamp in seconds
        const createTime = Number(BigInt(v.id) >> 32n);
        return {
          id: v.id,
          desc: v.desc || '',
          cover: v.coverUrl || '',
          authorUniqueId: v.authorUniqueId || cleanUser,
          url: `https://www.tiktok.com/@${v.authorUniqueId || cleanUser}/video/${v.id}`,
          createTime,
          createdAt: new Date(createTime * 1000).toISOString()
        };
      });

      return {
        success: true,
        user: {
          nickname: userInfo.nickname || cleanUser,
          uniqueId: userInfo.uniqueId || cleanUser,
          avatar: userInfo.avatarThumbUrl || '',
          signature: userInfo.signature || ''
        },
        videos
      };
    } catch (err) {
      if (attempt < maxRetries) continue;
      // Fallback to Layer 2 Direct Profile WAF
      const direct = await getDirectTikTokProfile(cleanUser);
      if (direct.success) {
        return direct;
      }
      return {
        success: false,
        error: err.message
      };
    }
  }
}
