// Repository links follow wherever the site is published: on owner.github.io/repo they point to
// github.com/owner/repo, so forks need no edits. Elsewhere (a local preview) they point to github.com.
const pages = location.hostname.match(/^([^.]+)\.github\.io$/i);
const repo = pages && location.pathname.split('/').filter(Boolean)[0];
const base = pages && repo ? 'https://github.com/' + pages[1] + '/' + repo : 'https://github.com';
for (const link of document.querySelectorAll('[data-repo]')) link.href = base + (pages && repo ? link.dataset.repo : '');

// Mark the sidebar entry for the section in view: the last one whose top has passed 40% of the window.
const links = [...document.querySelectorAll('.nav a[href^="#"]')];
const targets = links.map(a => document.querySelector(a.getAttribute('href')));
function mark() {
  let current = 0;
  targets.forEach((t, i) => { if (t && t.getBoundingClientRect().top <= innerHeight * 0.4) current = i; });
  // Sections near the end can never reach that line; at the bottom of the page, mark the last one.
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) current = targets.length - 1;
  links.forEach((a, i) => { if (i === current) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
}
if (links.length) { addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true }); mark(); }
