import { useMemo, type CSSProperties } from "react";
import styles from "./Layout.module.css";

interface ShootingStarStyle {
  top: string;
  right: string;
  "--star-size": string;
  "--tail-length": string;
  "--travel-x": string;
  "--travel-y": string;
  "--shoot-duration": string;
  "--shoot-delay": string;
  "--pulse-duration": string;
}

interface TwinkleStarStyle {
  left: string;
  top: string;
  width: string;
  height: string;
  "--twinkle-duration": string;
  "--twinkle-delay": string;
  "--twinkle-min": number;
  "--twinkle-max": number;
}

const STAR_LANES = [
  -18, -10, -2, 6, 14, 22, 30, 38, 46, 54, 62, 70,
];

function pseudoRandom(index: number, salt: number) {
  const value = Math.sin(index * 9283.31 + salt * 77.13) * 43758.5453;
  return value - Math.floor(value);
}

function createShootingStars(): ShootingStarStyle[] {
  return Array.from({ length: 28 }, (_, index) => {
    const lane = STAR_LANES[index % STAR_LANES.length];
    const pass = Math.floor(index / STAR_LANES.length);
    const isFast = index % 9 === 0;
    const duration = isFast
      ? 11 + (index % 4) * 0.8
      : 18 + (index % 7) * 1.35;
    const delayOffset = (index * 3.7 + pass * 5.2) % duration;

    return {
      top: `${lane + pass * 3}%`,
      right: `${-20 + ((index * 29) % 112)}%`,
      "--star-size": `${1.1 + (index % 6) * 0.26}px`,
      "--tail-length": `${82 + ((index * 37) % 142)}px`,
      "--travel-x": `${-900 - (index % 5) * 95}px`,
      "--travel-y": `${900 + (index % 5) * 95}px`,
      "--shoot-duration": `${duration}s`,
      "--shoot-delay": `${-delayOffset}s`,
      "--pulse-duration": `${0.9 + (index % 5) * 0.24}s`,
    };
  });
}

function createTwinkleStars(): TwinkleStarStyle[] {
  return Array.from({ length: 150 }, (_, index) => {
    const size = 0.55 + pseudoRandom(index, 3) * 1.25;
    const minOpacity = 0.12 + pseudoRandom(index, 5) * 0.2;
    const maxOpacity = 0.42 + pseudoRandom(index, 7) * 0.5;

    return {
      left: `${pseudoRandom(index, 11) * 100}%`,
      top: `${pseudoRandom(index, 17) * 100}%`,
      width: `${size}px`,
      height: `${size}px`,
      "--twinkle-duration": `${3.2 + pseudoRandom(index, 19) * 5.8}s`,
      "--twinkle-delay": `${-pseudoRandom(index, 23) * 8}s`,
      "--twinkle-min": minOpacity,
      "--twinkle-max": maxOpacity,
    };
  });
}

export function StarField() {
  const shootingStars = useMemo(createShootingStars, []);
  const twinkleStars = useMemo(createTwinkleStars, []);

  return (
    <div className={styles.starField} aria-hidden="true">
      {twinkleStars.map((style, index) => (
        <span
          className={styles.twinkleStar}
          key={`twinkle-${index}`}
          style={style as CSSProperties}
        />
      ))}
      {shootingStars.map((style, index) => (
        <span
          className={styles.shootingStar}
          key={`shooting-${index}`}
          style={style as CSSProperties}
        />
      ))}
    </div>
  );
}
