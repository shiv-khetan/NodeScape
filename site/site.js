// Repository links follow wherever the site is published: on owner.github.io/repo they point to
// github.com/owner/repo, so forks need no edits. Elsewhere (a local preview) they point to github.com.
const pages = location.hostname.match(/^([^.]+)\.github\.io$/i);
const repo = pages && location.pathname.split('/').filter(Boolean)[0];
const base = pages && repo ? 'https://github.com/' + pages[1] + '/' + repo : 'https://github.com';
for (const link of document.querySelectorAll('[data-repo]')) link.href = base + (pages && repo ? link.dataset.repo : '');

// Mark the sidebar entry for the section in view.
const links = [...document.querySelectorAll('.nav a[href^="#"]')];
const targets = links.map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
if ('IntersectionObserver' in window && targets.length) {
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    for (const a of links) { if (a.getAttribute('href') === '#' + visible.target.id) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }
  }, { rootMargin: '0px 0px -60% 0px' });
  targets.forEach(t => observer.observe(t));
}
