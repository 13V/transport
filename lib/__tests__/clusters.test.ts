import { buildClusters } from '../indexer/clusters';

describe('buildClusters', () => {
  it('forms two separate clusters from two disjoint funding chains', () => {
    // Chain A: A -> B -> C   Chain B: X -> Y -> Z
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
      { source: 'X', target: 'Y' },
      { source: 'Y', target: 'Z' },
    ];

    const clusters = buildClusters(edges);

    expect(clusters.get('A')).toEqual(['A', 'B', 'C']);
    expect(clusters.get('B')).toEqual(['A', 'B', 'C']);
    expect(clusters.get('C')).toEqual(['A', 'B', 'C']);

    expect(clusters.get('X')).toEqual(['X', 'Y', 'Z']);
    expect(clusters.get('Z')).toEqual(['X', 'Y', 'Z']);

    // Disjoint: A's cluster excludes the X chain.
    expect(clusters.get('A')).not.toContain('X');
  });

  it('merges two chains into one cluster when they share a wallet', () => {
    // Both chains funnel into shared wallet S.
    const edges = [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'S' },
      { source: 'X', target: 'Y' },
      { source: 'Y', target: 'S' },
    ];

    const clusters = buildClusters(edges);

    const expected = ['A', 'B', 'S', 'X', 'Y'];
    expect(clusters.get('A')).toEqual(expected);
    expect(clusters.get('X')).toEqual(expected);
    expect(clusters.get('S')).toEqual(expected);

    // Everyone resolves to the same single cluster.
    expect(clusters.get('A')).toEqual(clusters.get('X'));
  });

  it('treats a lone self-loop wallet as a cluster of one', () => {
    const edges = [{ source: 'Solo', target: 'Solo' }];

    const clusters = buildClusters(edges);

    expect(clusters.get('Solo')).toEqual(['Solo']);
  });

  it('returns an empty map for no edges', () => {
    expect(buildClusters([]).size).toBe(0);
  });

  it('keeps a wallet pair separate from an unrelated lone wallet', () => {
    const edges = [
      { source: 'P', target: 'Q' },
      // 'R' only appears via a self-loop, so it stands alone.
      { source: 'R', target: 'R' },
    ];

    const clusters = buildClusters(edges);

    expect(clusters.get('P')).toEqual(['P', 'Q']);
    expect(clusters.get('R')).toEqual(['R']);
  });
});
