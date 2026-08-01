const sharp = require("sharp");

const BOARD_SIZE = 8;

async function renderSolutionImage(solution) {
  if (
    !solution ||
    !Array.isArray(solution.moves) ||
    solution.moves.length !== 3
  ) {
    throw new Error("A three-move solution is required");
  }

  const TARGET_WIDTH = 1170;
  const outerPadding = 8;
  const boardGap = 28;
  const cellGap = 2;

  const usableWidth = TARGET_WIDTH - outerPadding * 2 - boardGap * 2;
  const gridSizePerBoard = Math.floor(usableWidth / 3);
  const cellSize = Math.floor((gridSizePerBoard - cellGap * 7) / 8);
  const gridSize = BOARD_SIZE * cellSize + (BOARD_SIZE - 1) * cellGap;
  const imageWidth = outerPadding * 2 + gridSize * 3 + boardGap * 2;
  const imageHeight = outerPadding * 2 + gridSize;

  const boards = solution.moves
    .map((move, index) => {
      const boardX = outerPadding + index * (gridSize + boardGap);
      const boardY = outerPadding;

      return renderMoveBoard({
        move,
        moveNumber: index + 1,
        boardX,
        boardY,
        cellSize,
        cellGap,
      });
    })
    .join("");

  const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${imageWidth} ${imageHeight}">
            <rect width="100%" height="100%" fill="#080b12"/>
            ${boards}
        </svg>
    `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function renderMoveBoard({
  move,
  moveNumber,
  boardX,
  boardY,
  cellSize,
  cellGap,
}) {
  const previewCells = [];
  const previewSet = new Set();
  const clearingCells = new Set();

  for (let shapeRow = 0; shapeRow < move.shape.length; shapeRow++) {
    for (let shapeCol = 0; shapeCol < move.shape[shapeRow].length; shapeCol++) {
      if (move.shape[shapeRow][shapeCol] !== 1) continue;
      const row = move.placement.row + shapeRow;
      const col = move.placement.col + shapeCol;

      previewCells.push({ row, col });
      previewSet.add(`${row},${col}`);
    }
  }

  for (const row of move.completedRows) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      clearingCells.add(`${row},${col}`);
    }
  }

  for (const col of move.completedCols) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      clearingCells.add(`${row},${col}`);
    }
  }

  const numberCell = getTopLeftCell(previewCells);

  const cells = [];

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const key = `${row},${col}`;

      const x = boardX + col * (cellSize + cellGap);

      const y = boardY + row * (cellSize + cellGap);

      const isPreview = previewSet.has(key);

      const isClearing = clearingCells.has(key);

      let fill = "#21293a";

      if (move.boardBefore[row][col] === 1) fill = "#587fdd";

      if (isPreview) fill = "#ffad32";

      cells.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="${Math.max(4, Math.floor(cellSize * 0.14))}" fill="${fill}" stroke="${isClearing ? "#36d399" : "#0f1522"}" stroke-width="${isClearing ? 3 : 1}"/>`,
      );

      if (numberCell && row === numberCell.row && col === numberCell.col) {
        cells.push(`
                    <text
                        x="${x + cellSize / 2}"
                        y="${y + cellSize / 2 + Math.max(6, Math.floor(cellSize * 0.12))}"
                        text-anchor="middle"
                        fill="#ffffff"
                        stroke="rgba(0,0,0,0.18)"
                        stroke-width="1"
                        paint-order="stroke"
                        font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif"
                        font-size="${Math.max(22, Math.floor(cellSize * 0.72))}"
                        font-weight="900"
                    >
                        ${moveNumber}
                    </text>
                `);
      }
    }
  }

  return `<g>${cells.join("")}</g>`;
}

function getTopLeftCell(cells) {
  if (!cells.length) {
    return null;
  }

  return [...cells].sort((a, b) => {
    if (a.row !== b.row) {
      return a.row - b.row;
    }

    return a.col - b.col;
  })[0];
}

module.exports = {
  renderSolutionImage,
};
