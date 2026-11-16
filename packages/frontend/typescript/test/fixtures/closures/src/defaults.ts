declare function use(value: unknown): unknown;

export default { m() { return 11; } };

use({ m() { return 12; } });
