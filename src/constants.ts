export const LEVELS = [1, 2, 3, 4, 5];

export const PADDLE_OPTIONS = [
  'Juciao',
  'Vole',
  'Selkirk Boomstik',
  'Selkirk Luxx',
  'Joola Perseus',
  'Joola Hyperion',
  'CRBN 1X',
  'Six Zero Double Black Diamond',
  'Ronbus R1',
  'Vatic Pro Prism Flash',
];

export const GRIP_COLOR_OPTIONS = [
  'Black',
  'White',
  'Blue',
  'Red',
  'Green',
  'Yellow',
  'Pink',
  'Purple',
  'Orange',
  'Gray',
];

export const LOCAL_STORAGE_KEY = 'openqueue-app-data';

export const getLevelRange = (level: number) => {
  if (level === 1) {
    return { minLevel: 1, maxLevel: 2 };
  }

  if (level === 2) {
    return { minLevel: 1, maxLevel: 3 };
  }

  if (level === 3 || level === 4) {
    return { minLevel: 3, maxLevel: 4 };
  }

  return { minLevel: 3, maxLevel: 5 };
};
