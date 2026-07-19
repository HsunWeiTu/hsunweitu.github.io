/* 墨 · INK — site interactions: reveal-on-scroll, mobile nav */
(function () {
	'use strict';

	/* reveal on scroll */
	var revealEls = document.querySelectorAll('.reveal');
	if ('IntersectionObserver' in window) {
		var io = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (entry.isIntersecting) {
					entry.target.classList.add('visible');
					io.unobserve(entry.target);
				}
			});
		}, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
		revealEls.forEach(function (el) { io.observe(el); });
	} else {
		revealEls.forEach(function (el) { el.classList.add('visible'); });
	}

	/* mobile nav toggle */
	var toggle = document.querySelector('.nav-toggle');
	var links = document.querySelector('.nav-links');
	if (toggle && links) {
		toggle.addEventListener('click', function () {
			toggle.classList.toggle('open');
			links.classList.toggle('open');
		});
	}

	/* mobile dropdown */
	document.querySelectorAll('.nav-drop-label').forEach(function (label) {
		label.addEventListener('click', function (e) {
			if (window.matchMedia('(max-width: 860px)').matches) {
				e.preventDefault();
				label.parentElement.classList.toggle('open');
			}
		});
	});
})();
