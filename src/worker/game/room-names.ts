// GAME_ROOM serves matches, user rooms and development games. Each kind uses its own
// name prefix so that IDs of different kinds never address the same Durable Object.
export const matchRoomName = (matchRoomId: string) => `match:${matchRoomId}`;
export const userRoomName = (roomId: string) => `room:${roomId}`;
export const developmentRoomName = (roomId: string) => `development:${roomId}`;
