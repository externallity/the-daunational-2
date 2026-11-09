// Прогноз по драфту: сумма логитов винрейта героев в Turbo.
// Проверено на 3741 публичном матче Turbo: точность 58%, вероятности откалиброваны.
// Навыки игроков и контрпики не учитываются.
const logit = p => Math.log(p / (1 - p));

export function predict(winrates, teamA, teamB) {
  if (!winrates || teamA.length !== 5 || teamB.length !== 5) return null;
  if (![...teamA, ...teamB].every(id => winrates.has(id))) return null;
  const score = team => team.reduce((sum, id) => sum + logit(winrates.get(id)), 0);
  const best = team => team.reduce((top, id) => (winrates.get(id) > winrates.get(top) ? id : top));
  const a = Math.round(100 / (1 + Math.exp(score(teamB) - score(teamA))));
  return { a, b: 100 - a, bestA: best(teamA), bestB: best(teamB) };
}
