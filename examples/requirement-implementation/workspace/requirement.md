# Implement `slugify(value)`

Update `slug.mjs` so `slugify`:

- throws `TypeError` for non-string input;
- trims and lowercases text;
- removes Unicode combining marks so `Crème brûlée` becomes `creme-brulee`;
- replaces each run of non-ASCII letters/digits with one `-`;
- removes leading and trailing `-` characters;
- returns an empty string for input containing no letters or digits.

Do not add dependencies or modify the exported function name.
