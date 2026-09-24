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

/**
 * Fetch TikTok user data and recent videos via embed state
 * @param {string} username TikTok username (with or without @)
 * @returns {Promise<{
 *   success: boolean,
 *   user?: {
 *     nickname: string,
 *     uniqueId: string,
 *     avatar: string,
 *     signature: string
 *   },
 *   videos?: Array<{
 *     id: string,
 *     desc: string,
 *     cover: string,
 *     authorUniqueId: string,
 *     url: string,
 *     createTime: number,
 *     createdAt: string
 *   }>,
 *   error?: string
 * }>}
 */
export async function getTikTokUserVideos(username, maxRetries = 2) {
  const cleanUser = username.replace(/^@/, '').trim();
  const handle = `@${cleanUser}`;
  const path = `/embed/${handle}`;
  const targetUrl = `https://www.tiktok.com${path}`;

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Referer': 'https://www.google.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site'
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Wait 1.5s before retry
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }

      let res = await fetch(targetUrl, { 
        headers, 
        signal: AbortSignal.timeout(8000) 
      });
      let html = await res.text();

      if (res.status === 503 || html.includes('overload-protect')) {
        if (attempt < maxRetries) continue;
        return {
          success: false,
          error: `TikTok overload-protect triggered for @${cleanUser}. (Status: 503)`
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
            signal: AbortSignal.timeout(8000)
          });
          html = await res.text();
        }
      }

      const match = html.match(
        /<script id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/
      );

      if (!match || !match[1]) {
        if (attempt < maxRetries) continue;
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
      return {
        success: false,
        error: err.message
      };
    }
  }
}
