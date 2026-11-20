// What a product image may look like. Shared by the image resolver (scripts/images.js) and the card builder
// (deals.js), so an image that could not be accepted can never be shown either. No database in here.

// Logos, sprites, icons, trackers, placeholders and brand share cards. "default" is only a placeholder when it is the
// whole file name: Under Armour's product shots are called ..._DEFAULT and are real photos.
export const REJECT_IMAGE = new RegExp(
  "(?:^|[/_.=-])(?:logos?|sprites?|icons?|favicon|placeholder|noimage|no-image|banner-ad|pixel|tracker|spacer|blank)(?:[/_.=?&-]|$)"
  + "|/default\\.(?:jpe?g|png|webp|gif)|social[-_]?shar|share[-_]image|\\b1x1\\b|\\.svg(?:[?#]|$)|/videos?/",
  "i",
);

export const MIN_IMAGE_SIDE = 200;

// The size an image URL asks for (wid=566&hei=708, maxWidth=345, size=566,708, _800x600), or null when it says nothing.
export function declaredSize(url) {
  const num = (re) => {
    const m = url.match(re);
    return m ? Number(m[1]) : null;
  };
  let w = num(/[?&;](?:wid|width|w|maxwidth)=(\d+)/i);
  let h = num(/[?&;](?:hei|height|h|maxheight)=(\d+)/i);
  const size = url.match(/[?&]size=(\d+),(\d+)/i);
  if (size) [w, h] = [Number(size[1]), Number(size[2])];
  const wxh = url.match(/[_/-](\d{2,4})x(\d{2,4})(?=[._/?-]|$)/);
  if (wxh && w === null && h === null) [w, h] = [Number(wxh[1]), Number(wxh[2])];
  return w === null && h === null ? null : { w, h };
}

// True for an https URL that is not a logo or icon and does not ask for a tiny image.
export function acceptableImageUrl(url) {
  if (typeof url !== "string" || !/^https:\/\//i.test(url) || url.length > 1000) return false;
  if (REJECT_IMAGE.test(url)) return false;
  const size = declaredSize(url);
  return !size || Math.max(size.w ?? 0, size.h ?? 0) >= MIN_IMAGE_SIDE;
}
