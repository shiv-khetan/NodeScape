// Bring `from`'s children in line with `to`'s, touching only what differs, so a live refresh keeps
// unchanged nodes, focus, hover and listeners instead of rebuilding the page every few seconds.
// ponytail: matches children by position, which suits pages whose structure is stable between renders.
export function morphChildren(from, to) {
  const before = [...from.childNodes], after = [...to.childNodes];
  after.forEach((node, i) => (before[i] ? morph(before[i], node) : from.append(node)));
  before.slice(after.length).forEach(node => node.remove());
}

function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { from.replaceWith(to); return; }
  if (from.nodeType !== Node.ELEMENT_NODE) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  morphChildren(from, to);
}
