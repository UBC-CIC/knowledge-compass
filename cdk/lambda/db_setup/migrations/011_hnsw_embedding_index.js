/**
 * 011_hnsw_embedding_index.js
 *
 * Replaces the IVFFlat embedding index from 001 with HNSW.
 *
 * IVFFlat with lists = 100 on a corpus of a few hundred chunks leaves ~4 rows
 * per list, and the default ivfflat.probes = 1 searches a single list. Nearest-
 * neighbour queries in retrieval.py therefore returned 0-1 rows instead of the
 * requested top-k, starving the chatbot of context. HNSW does not depend on
 * training data or list tuning, so recall stays high as the corpus grows.
 *
 * HNSW returns at most hnsw.ef_search rows per query (default 40). retrieval.py
 * requests num_results * CANDIDATE_MULTIPLIER (currently <= 21), which is within
 * that limit; raise hnsw.ef_search if that ever grows past 40.
 */

exports.up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_chunks_embedding_ivfflat;

    CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
      ON chunks USING hnsw (embedding vector_cosine_ops);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_chunks_embedding_hnsw;

    CREATE INDEX IF NOT EXISTS idx_chunks_embedding_ivfflat
      ON chunks USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  `);
};
