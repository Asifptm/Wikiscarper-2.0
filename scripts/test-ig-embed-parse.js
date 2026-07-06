const { fetchUrl } = require('../src/core/httpClient');

async function main() {
  const shortcode = 'fA9uwTtkSN';
  const r = await fetchUrl(`https://www.instagram.com/p/${shortcode}/embed/captioned/`);
  const jsonMatch = r.body.match(/"shortcode":"([^"]+)"/);
  const caption = r.body.match(/"caption":"([^"]*)"/);
  const likes = r.body.match(/"edge_liked_by":\{"count":(\d+)\}/);
  console.log('shortcode', jsonMatch?.[1], 'caption', caption?.[1]?.slice(0, 60), 'likes', likes?.[1]);
}

main();
