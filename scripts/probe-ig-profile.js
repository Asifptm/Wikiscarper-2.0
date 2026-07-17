const { fetchUrl } = require('../src/core/httpClient');
const fs = require('fs');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

(async () => {
  const username = 'microsoft';
  const urls = [
    `https://www.instagram.com/${username}/`,
    `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
  ];

  for (const url of urls) {
    try {
      const r = await fetchUrl(url, {
        userAgent: UA,
        timeout: 30000,
        headers:
          url.includes('web_profile_info')
            ? {
                'X-IG-App-ID': '936619743392459',
                Accept: '*/*',
              }
            : {},
      });
      console.log('\n===', url);
      console.log('status', r.statusCode, 'len', r.body.length);
      if (r.body.startsWith('{')) {
        const j = JSON.parse(r.body);
        const user = j.data?.user;
        console.log('user', user?.username, 'posts', user?.edge_owner_to_timeline_media?.count);
        const edges = user?.edge_owner_to_timeline_media?.edges ?? [];
        console.log('edges', edges.length);
        if (edges[0]) {
          const n = edges[0].node;
          console.log('first', n.shortcode, n.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 60));
        }
      } else {
        const shortcodes = [...r.body.matchAll(/"shortcode":"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
        console.log('shortcodes', [...new Set(shortcodes)].slice(0, 10));
        fs.writeFileSync('scripts/ig-profile.html', r.body.slice(0, 500000));
      }
    } catch (e) {
      console.log('\n===', url, 'ERR', e.message);
    }
  }
})();
