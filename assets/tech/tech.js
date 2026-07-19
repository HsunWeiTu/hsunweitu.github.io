/* ============================================================
   WES.TU — ROBOTICS · interaction engine
   1. Servo cursor (dot + reticle ring)
   2. Reactive dot-grid background
   3. AGV file-retrieval arm — rides a floor rail fixed to the
      bottom of the viewport, follows the pointer anywhere on
      screen, and physically pulls drawer-buttons to navigate.
      V-shaped gripper fingers, per-joint angle readouts,
      end-effector XY coordinates.
   4. Boot-sequence typing line
   5. Count-up stats, capability bars, radar chart
   6. Reveal-on-scroll, mobile nav, card tilt
   ============================================================ */
(function () {
	'use strict';

	var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	var finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

	var mouse = { x: innerWidth * 0.6, y: innerHeight * 0.45, active: false };
	window.addEventListener('pointermove', function (e) {
		mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true;
	}, { passive: true });

	/* ================= 1. servo cursor ================= */
	if (finePointer && !reduceMotion) (function () {
		var dot = document.createElement('div'); dot.id = 'cursor-dot';
		var ring = document.createElement('div'); ring.id = 'cursor-ring';
		document.body.appendChild(dot); document.body.appendChild(ring);
		var rx = mouse.x, ry = mouse.y;
		(function loop() {
			requestAnimationFrame(loop);
			rx += (mouse.x - rx) * 0.16;
			ry += (mouse.y - ry) * 0.16;
			dot.style.transform = 'translate(' + (mouse.x - 2.5) + 'px,' + (mouse.y - 2.5) + 'px)';
			ring.style.transform = 'translate(' + (rx - ring.offsetWidth / 2) + 'px,' + (ry - ring.offsetHeight / 2) + 'px)';
		})();
		document.addEventListener('pointerover', function (e) {
			if (e.target.closest('a, button, [data-magnetic], input, iframe, video')) ring.classList.add('hovering');
		});
		document.addEventListener('pointerout', function (e) {
			if (e.target.closest('a, button, [data-magnetic], input, iframe, video')) ring.classList.remove('hovering');
		});
	})();

	/* ================= 2. reactive dot grid ================= */
	(function () {
		var cv = document.getElementById('grid-canvas');
		if (!cv || reduceMotion) { if (cv) cv.style.display = 'none'; return; }
		var ctx = cv.getContext('2d');
		var SPACING = 30, base, W, H, cols, rows;

		function build() {
			var dpr = Math.min(devicePixelRatio || 1, 2);
			W = innerWidth; H = innerHeight;
			cv.width = W * dpr; cv.height = H * dpr;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			cols = Math.ceil(W / SPACING) + 1;
			rows = Math.ceil(H / SPACING) + 1;
			base = document.createElement('canvas');
			base.width = cv.width; base.height = cv.height;
			var bctx = base.getContext('2d');
			bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			bctx.fillStyle = 'rgba(233, 231, 223, 0.07)';
			for (var i = 0; i < cols; i++)
				for (var j = 0; j < rows; j++) {
					bctx.beginPath();
					bctx.arc(i * SPACING, j * SPACING, 1, 0, Math.PI * 2);
					bctx.fill();
				}
		}
		build();
		addEventListener('resize', build);

		var R = 150;
		(function frame() {
			requestAnimationFrame(frame);
			ctx.clearRect(0, 0, W, H);
			ctx.drawImage(base, 0, 0, W, H);
			if (!mouse.active) return;
			var i0 = Math.max(0, Math.floor((mouse.x - R) / SPACING)),
				i1 = Math.min(cols - 1, Math.ceil((mouse.x + R) / SPACING)),
				j0 = Math.max(0, Math.floor((mouse.y - R) / SPACING)),
				j1 = Math.min(rows - 1, Math.ceil((mouse.y + R) / SPACING));
			for (var i = i0; i <= i1; i++)
				for (var j = j0; j <= j1; j++) {
					var gx = i * SPACING, gy = j * SPACING;
					var dx = gx - mouse.x, dy = gy - mouse.y;
					var d = Math.hypot(dx, dy);
					if (d > R) continue;
					var t = 1 - d / R;
					var push = t * t * 7;
					var px = gx + (dx / (d || 1)) * push;
					var py = gy + (dy / (d || 1)) * push;
					ctx.beginPath();
					ctx.fillStyle = 'rgba(242, 163, 92, ' + (0.10 + t * 0.5) + ')';
					ctx.arc(px, py, 1 + t * 1.4, 0, Math.PI * 2);
					ctx.fill();
				}
		})();
	})();

	/* ================= 3. AGV file-retrieval arm ================= */
	(function () {
		if (reduceMotion || !finePointer) return;
		if (matchMedia('(max-width: 900px)').matches) return;

		var cv = document.createElement('canvas');
		cv.id = 'agv-canvas';
		document.body.appendChild(cv);
		var fade = document.createElement('div');
		fade.id = 'page-fade';
		document.body.appendChild(fade);

		var ctx = cv.getContext('2d');
		var W, H, dpr, L1, L2;
		function resize() {
			dpr = Math.min(devicePixelRatio || 1, 2);
			W = innerWidth; H = innerHeight;
			cv.width = W * dpr; cv.height = H * dpr;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			/* crane geometry: short upper arm, long forearm — the forearm
			   sweeps LEFT across the screen while J1 stays at a low angle */
			L1 = H * 0.45;
			L2 = H * 0.62;
		}
		resize();
		addEventListener('resize', resize);

		var railY;                       // set each frame: H - 14
		var agvX = innerWidth * 0.72;
		var a1 = -Math.PI / 2.6, a2 = Math.PI / 2;
		var gripOpen = 0.75;             // smoothed claw opening
		var pinch = false;               // left button held → claw pinches
		var state = 'idle';              // idle → grab → pull → done
		var grabEl = null, phaseT = 0, pendingHref = null;
		var trail = [];

		addEventListener('pointerdown', function (e) { if (e.button === 0) pinch = true; }, { passive: true });
		addEventListener('pointerup', function () { pinch = false; }, { passive: true });

		function handlePos(el) {
			var r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.bottom - 6 };
		}

		/* intercept every internal link (nav drawers + page buttons) */
		document.querySelectorAll('a[href]').forEach(function (link) {
			var href = link.getAttribute('href');
			if (!href || /^(https?:|mailto:|tel:|#)/i.test(href)) return;
			link.addEventListener('click', function (e) {
				e.preventDefault();
				if (state !== 'idle') return;
				grabEl = link;
				pendingHref = href;
				phaseT = performance.now();
				state = 'grab';
				var drop = link.closest('.nav-dropdown');
				if (drop) drop.classList.add('hold-open');
			});
		});

		function solveIK(bx, by, tx, ty, flip) {
			var dx = tx - bx, dy = ty - by;
			var d = Math.hypot(dx, dy);
			d = Math.max(Math.abs(L1 - L2) + 4, Math.min(L1 + L2 - 4, d));
			var q1 = Math.acos(Math.max(-1, Math.min(1, (d * d + L1 * L1 - L2 * L2) / (2 * d * L1))));
			var q2 = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2))));
			var base = Math.atan2(dy, dx);
			return [base + flip * q1, -flip * (Math.PI - q2)];
		}

		/* shortest-path angular interpolation — wraps the delta to ±π so a
		   2π jump in the IK target (atan2 discontinuity) never makes the arm
		   sweep a full circle */
		function angLerp(cur, target, t) {
			var d = target - cur;
			d = Math.atan2(Math.sin(d), Math.cos(d));
			return cur + d * t;
		}

		function seg(x1, y1, x2, y2, w, color) {
			ctx.beginPath();
			ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
			ctx.lineWidth = w;
			ctx.lineCap = 'round';
			ctx.strokeStyle = color;
			ctx.stroke();
		}
		function joint(x, y, r, hot) {
			ctx.beginPath();
			ctx.arc(x, y, r, 0, Math.PI * 2);
			ctx.fillStyle = '#14161b';
			ctx.fill();
			ctx.lineWidth = 1.4;
			ctx.strokeStyle = hot ? 'rgba(242,163,92,0.9)' : 'rgba(233,231,223,0.4)';
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
			ctx.fillStyle = hot ? 'rgba(242,163,92,0.9)' : 'rgba(233,231,223,0.35)';
			ctx.fill();
		}

		/* V-shaped gripper finger: knuckle segment out, tip segment bends inward */
		function finger(hx, hy, ga, open, side, color) {
			var KN = 12, TIP = 10, BEND = 0.85;
			var a0 = ga + side * open;
			var kx = hx + Math.cos(a0) * KN, ky = hy + Math.sin(a0) * KN;
			var a1f = a0 - side * BEND;
			var txp = kx + Math.cos(a1f) * TIP, typ = ky + Math.sin(a1f) * TIP;
			seg(hx, hy, kx, ky, 2.2, color);
			seg(kx, ky, txp, typ, 2, color);
			ctx.beginPath();
			ctx.arc(kx, ky, 1.6, 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.fill();
		}

		(function frame(now) {
			requestAnimationFrame(frame);
			ctx.clearRect(0, 0, W, H);
			ctx.globalAlpha = 0.68;          // keep the arm from blocking content
			railY = H - 14;

			/* ---- pick target + state machine ---- */
			var target, wantClosed = false;
			if (state === 'grab' || state === 'pull' || state === 'done') {
				target = handlePos(grabEl);
				wantClosed = state !== 'grab';
				if (state === 'grab') {
					/* close in on the knob; approach hover point slightly above it */
					if (now - phaseT > 1100) { startPull(now); }
				}
				if (state === 'pull' && now - phaseT > 500) {
					state = 'done';
					fade.classList.add('on');
					setTimeout(function () { location.href = pendingHref; }, 260);
				}
			} else if (mouse.active) {
				target = { x: mouse.x, y: mouse.y };
			} else {
				target = { x: W * 0.5, y: H * 0.55 };
			}
			function startPull(t) {
				grabEl.classList.add('drawer-pulling');
				state = 'pull';
				phaseT = t;
			}

			/* ---- AGV drives along the floor rail ----
			   The base always stays RIGHT of the target (offset grows with
			   target height) so the long forearm reaches LEFT across the
			   screen, J1 stays low, and the elbow never mirror-flips.
			   The AGV may drive past the right edge to serve corner targets —
			   the offset keeps every point inside the reach annulus. */
			var by = railY - 22;
			var offset = H * 0.195 + 0.22 * Math.max(0, by - target.y);
			var goal = Math.max(40, Math.min(W + H * 0.45, target.x + offset));
			agvX += (goal - agvX) * 0.13;
			var bx = agvX;

			/* ---- IK with servo lag (fixed elbow branch — no flips) ---- */
			var sol = solveIK(bx, by, target.x, target.y, 1);
			a1 = angLerp(a1, sol[0], 0.14);
			a2 = angLerp(a2, sol[1], 0.14);

			var ex = bx + Math.cos(a1) * L1, ey = by + Math.sin(a1) * L1;
			var hx = ex + Math.cos(a1 + a2) * L2, hy = ey + Math.sin(a1 + a2) * L2;

			/* gripper reaches knob during grab → close early for a real pinch */
			if (state === 'grab' && Math.hypot(hx - target.x, hy - target.y) < 15 && performance.now() - phaseT > 220) {
				startPull(now);
			}

			/* ---- claw opening ----
			   resting: open wide · left-click: pinch · holding a knob: full grip */
			var openGoal;
			if (wantClosed) openGoal = 0.12;
			else if (state === 'grab') openGoal = 0.9;                        // anticipation
			else if (pinch) openGoal = 0.26;                                  // click feedback
			else openGoal = 0.7 + Math.min(0.25, Math.hypot(target.x - hx, target.y - hy) / 340);
			gripOpen += (openGoal - gripOpen) * ((wantClosed || pinch) ? 0.25 : 0.12);

			/* ---- floor rail (always at the bottom of the viewport) ---- */
			ctx.setLineDash([1, 7]);
			seg(0, railY, W, railY, 1, 'rgba(233,231,223,0.16)');
			ctx.setLineDash([]);

			/* ---- end-effector trail ---- */
			trail.push({ x: hx, y: hy });
			if (trail.length > 36) trail.shift();
			for (var i = 1; i < trail.length; i++) {
				seg(trail[i - 1].x, trail[i - 1].y, trail[i].x, trail[i].y, 1.3, 'rgba(76,200,163,' + ((i / trail.length) * 0.22) + ')');
			}

			/* ---- AGV carriage (kept from the gantry trolley, grounded) ---- */
			ctx.fillStyle = '#191c22';
			ctx.strokeStyle = 'rgba(233,231,223,0.4)';
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			if (ctx.roundRect) ctx.roundRect(bx - 24, railY - 16, 48, 13, 3); else ctx.rect(bx - 24, railY - 16, 48, 13);
			ctx.fill(); ctx.stroke();
			/* wheels on the rail */
			joint(bx - 14, railY - 3, 3.4, false);
			joint(bx + 14, railY - 3, 3.4, false);
			/* turret riser */
			seg(bx - 7, railY - 16, bx - 4, by + 3, 1.4, 'rgba(233,231,223,0.35)');
			seg(bx + 7, railY - 16, bx + 4, by + 3, 1.4, 'rgba(233,231,223,0.35)');

			/* ---- arm segments ---- */
			seg(bx, by, ex, ey, 7, 'rgba(233,231,223,0.16)');
			seg(bx, by, ex, ey, 2.4, 'rgba(233,231,223,0.55)');
			seg(ex, ey, hx, hy, 5, 'rgba(233,231,223,0.14)');
			seg(ex, ey, hx, hy, 1.8, 'rgba(233,231,223,0.5)');

			joint(bx, by, 9, false);       // J1
			joint(ex, ey, 6.5, false);     // J2

			/* ---- V-shaped gripper ---- */
			var ga = a1 + a2;
			var gcol = wantClosed ? 'rgba(76,200,163,0.95)' : 'rgba(242,163,92,0.95)';
			finger(hx, hy, ga, gripOpen, 1, gcol);
			finger(hx, hy, ga, gripOpen, -1, gcol);
			joint(hx, hy, 4.5, true);

			/* ---- per-joint readouts ---- */
			ctx.font = '9px "JetBrains Mono", monospace';
			ctx.fillStyle = 'rgba(233,231,223,0.42)';
			ctx.textAlign = 'left';
			function norm(d) { return ((d + 540) % 360) - 180; }
			var j1deg = norm(-a1 * 180 / Math.PI);
			var j2deg = norm(-a2 * 180 / Math.PI);
			ctx.fillText('J1 ' + j1deg.toFixed(1) + '°', bx + 14, by + 4);
			ctx.fillText('J2 ' + j2deg.toFixed(1) + '°', ex + 11, ey - 8);
			ctx.fillText('X ' + Math.round(hx) + '  Y ' + Math.round(hy), hx + 15, hy + 3);
			window.__agv = { hx: hx, hy: hy, tx: target.x, ty: target.y, j1: j1deg, j2: j2deg, bx: bx };

			/* ---- status ---- */
			ctx.fillStyle = 'rgba(233,231,223,0.3)';
			var label = state === 'idle' ? 'AGV.BOT — TRACKING' :
				state === 'grab' ? 'REACHING…' :
				state === 'pull' ? 'RETRIEVING FILE…' : 'LOADING…';
			ctx.fillText(label, Math.min(bx + 30, W - 170), railY - 6);
		})(performance.now());
	})();

	/* ================= 4. boot typing line ================= */
	(function () {
		var el = document.querySelector('.hero-boot .typed');
		if (!el) return;
		var phrases;
		try { phrases = JSON.parse(el.getAttribute('data-phrases')); } catch (e) { phrases = null; }
		if (!phrases || !phrases.length) phrases = ['loading…'];
		if (reduceMotion) { el.textContent = phrases[0]; return; }
		var pi = 0, ci = 0, deleting = false;
		(function tick() {
			var phrase = phrases[pi];
			if (!deleting) {
				ci++;
				el.textContent = phrase.slice(0, ci);
				if (ci === phrase.length) { deleting = true; setTimeout(tick, 2100); return; }
				setTimeout(tick, 42 + Math.random() * 50);
			} else {
				ci--;
				el.textContent = phrase.slice(0, ci);
				if (ci === 0) { deleting = false; pi = (pi + 1) % phrases.length; setTimeout(tick, 350); return; }
				setTimeout(tick, 22);
			}
		})();
	})();

	/* ================= 5. reveal + counters + bars + radar ================= */
	var revealEls = document.querySelectorAll('.reveal, .cap-item');
	function onVisible(el) {
		el.classList.add('visible');
		el.querySelectorAll('[data-count]').forEach(function (n) {
			if (n._counted) return;
			n._counted = true;
			var end = parseFloat(n.getAttribute('data-count'));
			var dur = 1400, start = performance.now();
			(function step(now) {
				var t = Math.min(1, (now - start) / dur);
				t = 1 - Math.pow(1 - t, 3);
				n.textContent = Math.round(end * t);
				if (t < 1) requestAnimationFrame(step);
			})(start);
		});
		if (el.querySelector && el.querySelector('#radar-chart') && !el._radar) {
			el._radar = true;
			drawRadar(el.querySelector('#radar-chart'));
		}
	}
	if ('IntersectionObserver' in window && !reduceMotion) {
		var io = new IntersectionObserver(function (entries) {
			entries.forEach(function (entry) {
				if (entry.isIntersecting) { onVisible(entry.target); io.unobserve(entry.target); }
			});
		}, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
		revealEls.forEach(function (el) { io.observe(el); });
	} else {
		revealEls.forEach(onVisible);
	}

	function drawRadar(cv) {
		var labels, values;
		try {
			labels = JSON.parse(cv.getAttribute('data-labels'));
			values = JSON.parse(cv.getAttribute('data-values'));
		} catch (e) { return; }
		var dpr = Math.min(devicePixelRatio || 1, 2);
		var size = cv.clientWidth || 360;
		cv.width = size * dpr; cv.height = size * dpr;
		var ctx = cv.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		var cx = size / 2, cy = size / 2, R = size * 0.285;
		var N = labels.length;
		var start = performance.now(), dur = reduceMotion ? 0 : 1300;

		function angle(i) { return -Math.PI / 2 + (i / N) * Math.PI * 2; }

		(function draw(now) {
			var t = dur === 0 ? 1 : Math.min(1, (now - start) / dur);
			t = 1 - Math.pow(1 - t, 3);
			ctx.clearRect(0, 0, size, size);

			for (var ring = 1; ring <= 4; ring++) {
				ctx.beginPath();
				for (var i = 0; i <= N; i++) {
					var a = angle(i % N), r = R * ring / 4;
					var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
					i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
				}
				ctx.strokeStyle = 'rgba(233,231,223,' + (ring === 4 ? 0.22 : 0.09) + ')';
				ctx.lineWidth = 1;
				ctx.stroke();
			}
			for (i = 0; i < N; i++) {
				var a2 = angle(i);
				ctx.beginPath();
				ctx.moveTo(cx, cy);
				ctx.lineTo(cx + Math.cos(a2) * R, cy + Math.sin(a2) * R);
				ctx.strokeStyle = 'rgba(233,231,223,0.09)';
				ctx.stroke();
			}
			ctx.beginPath();
			for (i = 0; i <= N; i++) {
				var k = i % N, a3 = angle(k);
				var r3 = R * values[k] * t;
				var x3 = cx + Math.cos(a3) * r3, y3 = cy + Math.sin(a3) * r3;
				i === 0 ? ctx.moveTo(x3, y3) : ctx.lineTo(x3, y3);
			}
			ctx.closePath();
			ctx.fillStyle = 'rgba(242,163,92,0.13)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(242,163,92,0.85)';
			ctx.lineWidth = 1.6;
			ctx.stroke();
			for (i = 0; i < N; i++) {
				var a4 = angle(i), r4 = R * values[i] * t;
				ctx.beginPath();
				ctx.arc(cx + Math.cos(a4) * r4, cy + Math.sin(a4) * r4, 2.6, 0, Math.PI * 2);
				ctx.fillStyle = '#4cc8a3';
				ctx.fill();
			}
			ctx.font = '10px "JetBrains Mono", "Noto Sans TC", monospace';
			ctx.fillStyle = 'rgba(233,231,223,0.6)';
			for (i = 0; i < N; i++) {
				var a5 = angle(i);
				var lx = cx + Math.cos(a5) * (R + 22), ly = cy + Math.sin(a5) * (R + 20);
				ctx.textAlign = Math.abs(Math.cos(a5)) < 0.3 ? 'center' : (Math.cos(a5) > 0 ? 'left' : 'right');
				ctx.textBaseline = 'middle';
				ctx.fillText(labels[i], lx, ly);
			}
			if (t < 1) requestAnimationFrame(draw);
		})(start);
	}

	/* ================= 6. nav + tilt ================= */
	/* inject hover scan layer into every button */
	document.querySelectorAll('.btn').forEach(function (b) {
		if (b.querySelector('.btn-scan')) return;
		var s = document.createElement('span'); s.className = 'btn-scan'; s.setAttribute('aria-hidden', 'true');
		b.appendChild(s);
	});

	var toggle = document.querySelector('.nav-toggle');
	var links = document.querySelector('.nav-links');
	if (toggle && links) {
		toggle.addEventListener('click', function () {
			toggle.classList.toggle('open');
			links.classList.toggle('open');
		});
	}
	document.querySelectorAll('.nav-drop-label').forEach(function (label) {
		label.addEventListener('click', function (e) {
			if (matchMedia('(max-width: 900px)').matches) {
				e.preventDefault();
				label.parentElement.classList.toggle('open');
			}
		});
	});

	if (finePointer && !reduceMotion) {
		document.querySelectorAll('.tech-card').forEach(function (card) {
			card.addEventListener('pointermove', function (e) {
				var r = card.getBoundingClientRect();
				var px = (e.clientX - r.left) / r.width - 0.5;
				var py = (e.clientY - r.top) / r.height - 0.5;
				card.style.transform = 'perspective(800px) rotateY(' + (px * 5) + 'deg) rotateX(' + (-py * 5) + 'deg) translateY(-4px)';
			});
			card.addEventListener('pointerleave', function () {
				card.style.transform = '';
			});
		});
	}

	/* signal that the interaction engine loaded and ran — used by the
	   per-page failsafe to decide whether to force-reveal content */
	window.__wesReady = true;
})();
