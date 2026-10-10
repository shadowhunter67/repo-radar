const SCALE: [number, string][] = [
  [95, 'A+'],
  [90, 'A'],
  [85, 'A-'],
  [80, 'B+'],
  [75, 'B'],
  [70, 'B-'],
  [65, 'C+'],
  [60, 'C'],
  [55, 'C-'],
  [45, 'D'],
];

export function gradeFor(score: number): string {
  for (const [min, g] of SCALE) if (score >= min) return g;
  return 'F';
}
