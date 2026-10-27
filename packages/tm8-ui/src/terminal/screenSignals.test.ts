import { describe, expect, it } from 'vitest';
import { decodeUserVar, frameFromIip, userVarFromOsc } from './screenSignals';

describe('screen signals', () => {
  it('reads an inline JPEG frame as a data URL, and ignores anything not inline', () => {
    expect(frameFromIip('File=inline=1;size=4;width=40:/9j/AAAA')).toBe('data:image/jpeg;base64,/9j/AAAA');
    expect(frameFromIip('File=inline=1:iVBORw0K')).toBe('data:image/png;base64,iVBORw0K');
    expect(frameFromIip('File=size=4:/9j/AAAA')).toBeNull();
    expect(frameFromIip('SetUserVar=a=YQ==')).toBeNull();
  });

  it('reads a user var, and refuses names or values that are not plain', () => {
    expect(userVarFromOsc('SetUserVar=tm8step=eyJpIjowfQ==')).toEqual({ name: 'tm8step', base64: 'eyJpIjowfQ==' });
    expect(userVarFromOsc('SetUserVar=bad name=YQ==')).toBeNull();
    expect(userVarFromOsc('SetUserVar=x=<script>')).toBeNull();
    expect(decodeUserVar(Buffer.from('✔ ok', 'utf8').toString('base64'))).toBe('✔ ok');
  });
});
