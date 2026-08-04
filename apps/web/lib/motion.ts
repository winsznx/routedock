// Shared Framer Motion config — Section 3.5 of ROUTEDOCK_MASTER.md

export const fadeInUp = {
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] as const },
}

export const STAGGER = 0.06

export const EASE_CUBIC: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94]
