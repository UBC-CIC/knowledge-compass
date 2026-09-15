/**
 * 005_video_data_source_type.js
 *
 * Adds `video` to data_source_type so admins can stage uploaded videos for
 * Amazon Transcribe + the pgvector transcriber ECS task.
 */

exports.up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`ALTER TYPE data_source_type ADD VALUE IF NOT EXISTS 'video';`);
};

exports.down = () => {
  // Enum values cannot be removed safely once in use.
};
