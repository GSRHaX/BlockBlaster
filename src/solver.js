const BOARD_SIZE = 8;

const FUTURE_SURVIVAL_SHAPES = [
  {
    shape: [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ],
    missingPenalty: 2800,
  },
  {
    shape: [[1, 1, 1, 1, 1]],
    missingPenalty: 1500,
  },
  {
    shape: [[1], [1], [1], [1], [1]],
    missingPenalty: 1500,
  },
  {
    shape: [
      [1, 0, 0],
      [1, 0, 0],
      [1, 1, 1],
    ],
    missingPenalty: 900,
  },
  {
    shape: [
      [0, 0, 1],
      [0, 0, 1],
      [1, 1, 1],
    ],
    missingPenalty: 900,
  },
  {
    shape: [
      [1, 1, 1],
      [1, 0, 0],
      [1, 0, 0],
    ],
    missingPenalty: 900,
  },
  {
    shape: [
      [1, 1, 1],
      [0, 0, 1],
      [0, 0, 1],
    ],
    missingPenalty: 900,
  },
];

function solveBoard(
  board,
  rawPieces,
  comboState = {
    streak: 0,
    misses: 0,
  },
) {
  validateBoard(board);

  if (!Array.isArray(rawPieces) || rawPieces.length !== 3) {
    throw new Error("Exactly three pieces are required");
  }

  const pieces = rawPieces.map((shape, index) => {
    const trimmedShape = trimShape(shape);

    if (!trimmedShape) {
      throw new Error(`Piece ${index + 1} is empty`);
    }

    return {
      id: index,
      label: `Piece ${index + 1}`,
      shape: trimmedShape,
    };
  });

  return searchBestSequence(cloneMatrix(board), pieces, comboState);
}

function searchBestSequence(startBoard, pieces, initialComboState) {
  let best = null;

  const startingState = {
    streak: initialComboState.streak ?? 0,
    misses: initialComboState.misses ?? 0,
    broken: false,
  };

  function recurse(
    currentBoard,
    remainingPieces,
    moves,
    currentComboState,
    estimatedPoints,
    clearingMoves,
    totalLines,
  ) {
    if (remainingPieces.length === 0) {
      const boardScore = evaluateBoard(currentBoard);

      const comboRunway =
        currentComboState.streak > 0
          ? (2 - currentComboState.misses) * 6000
          : 0;

      const comboGrowth = currentComboState.streak - startingState.streak;

      const comboBreakPenalty =
        startingState.streak > 0 && currentComboState.broken ? 100_000_000 : 0;

      const finalScore =
        estimatedPoints * 1000 +
        comboGrowth * 20_000 +
        clearingMoves * 8_000 +
        comboRunway +
        boardScore -
        comboBreakPenalty;

      const candidate = {
        score: finalScore,
        estimatedPoints,
        linesCleared: totalLines,
        clearingMoves,
        finalBoard: cloneMatrix(currentBoard),

        finalComboState: {
          streak: currentComboState.streak,
          misses: currentComboState.misses,
          broken: currentComboState.broken,
        },

        moves,
      };

      if (best === null || candidate.score > best.score) {
        best = candidate;
      }

      return;
    }

    const usedShapesAtDepth = new Set();

    for (
      let pieceIndex = 0;
      pieceIndex < remainingPieces.length;
      pieceIndex++
    ) {
      const piece = remainingPieces[pieceIndex];
      const signature = JSON.stringify(piece.shape);

      if (usedShapesAtDepth.has(signature)) {
        continue;
      }

      usedShapesAtDepth.add(signature);

      const placements = findSpace(currentBoard, piece.shape);

      for (const placement of placements) {
        const placementResult = simulatePlacement(
          currentBoard,
          piece.shape,
          placement,
        );

        const comboResult = applyComboMove(
          currentComboState,
          placementResult.linesCleared,
        );

        const nextRemaining = remainingPieces.filter(
          (_, index) => index !== pieceIndex,
        );

        recurse(
          placementResult.board,
          nextRemaining,

          [
            ...moves,
            {
              pieceId: piece.id,
              label: piece.label,
              shape: piece.shape,
              placement,

              boardBefore: cloneMatrix(currentBoard),

              boardAfter: cloneMatrix(placementResult.board),

              completedRows: placementResult.completedRows,

              completedCols: placementResult.completedCols,

              linesCleared: placementResult.linesCleared,

              estimatedPoints: comboResult.points,

              comboBefore: {
                streak: currentComboState.streak,

                misses: currentComboState.misses,
              },

              comboAfter: {
                streak: comboResult.state.streak,

                misses: comboResult.state.misses,
              },
            },
          ],

          comboResult.state,

          estimatedPoints + comboResult.points,

          clearingMoves + (placementResult.linesCleared > 0 ? 1 : 0),

          totalLines + placementResult.linesCleared,
        );
      }
    }
  }

  recurse(startBoard, pieces, [], startingState, 0, 0, 0);

  return best;
}

function findSpace(board, shape) {
  const placements = [];

  const shapeRows = shape.length;
  const shapeCols = shape[0].length;

  for (let anchorRow = 0; anchorRow <= BOARD_SIZE - shapeRows; anchorRow++) {
    for (let anchorCol = 0; anchorCol <= BOARD_SIZE - shapeCols; anchorCol++) {
      let fits = true;

      checkShape: for (let shapeRow = 0; shapeRow < shapeRows; shapeRow++) {
        for (let shapeCol = 0; shapeCol < shapeCols; shapeCol++) {
          if (
            shape[shapeRow][shapeCol] === 1 &&
            board[anchorRow + shapeRow][anchorCol + shapeCol] === 1
          ) {
            fits = false;
            break checkShape;
          }
        }
      }

      if (fits) {
        placements.push({
          row: anchorRow,
          col: anchorCol,
        });
      }
    }
  }

  return placements;
}

function simulatePlacement(board, shape, placement) {
  const simulated = cloneMatrix(board);

  for (let shapeRow = 0; shapeRow < shape.length; shapeRow++) {
    for (let shapeCol = 0; shapeCol < shape[shapeRow].length; shapeCol++) {
      if (shape[shapeRow][shapeCol] !== 1) {
        continue;
      }

      simulated[placement.row + shapeRow][placement.col + shapeCol] = 1;
    }
  }

  const completedRows = [];
  const completedCols = [];

  for (let row = 0; row < BOARD_SIZE; row++) {
    if (simulated[row].every((value) => value === 1)) {
      completedRows.push(row);
    }
  }

  for (let col = 0; col < BOARD_SIZE; col++) {
    let complete = true;

    for (let row = 0; row < BOARD_SIZE; row++) {
      if (simulated[row][col] === 0) {
        complete = false;
        break;
      }
    }

    if (complete) {
      completedCols.push(col);
    }
  }

  for (const row of completedRows) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      simulated[row][col] = 0;
    }
  }

  for (const col of completedCols) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      simulated[row][col] = 0;
    }
  }

  return {
    board: simulated,
    completedRows,
    completedCols,

    linesCleared: completedRows.length + completedCols.length,
  };
}

function applyComboMove(currentState, linesCleared) {
  const state = {
    streak: currentState.streak ?? 0,
    misses: currentState.misses ?? 0,
    broken: currentState.broken ?? false,
  };

  if (linesCleared > 0) {
    const points = baseClearScore(linesCleared) * (state.streak + 1);

    return {
      points,

      state: {
        streak: state.streak + 1,
        misses: 0,
        broken: state.broken,
      },
    };
  }

  const newMisses = state.misses + 1;

  if (newMisses >= 3) {
    return {
      points: 0,

      state: {
        streak: 0,
        misses: 0,

        broken: state.broken || state.streak > 0,
      },
    };
  }

  return {
    points: 0,

    state: {
      streak: state.streak,
      misses: newMisses,
      broken: state.broken,
    },
  };
}

function baseClearScore(linesCleared) {
  if (linesCleared <= 0) {
    return 0;
  }

  if (linesCleared === 1) {
    return 10;
  }

  return 10 * linesCleared * (linesCleared - 1);
}

function evaluateBoard(board) {
  const occupiedCells = board.flat().filter((value) => value === 1).length;

  const targetOccupiedCells = 16;

  let occupancyScore = -Math.abs(occupiedCells - targetOccupiedCells) * 55;

  if (occupiedCells > 32) {
    occupancyScore -= (occupiedCells - 32) * 220;
  }

  const fullClearPenalty = occupiedCells === 0 ? 3500 : 0;

  return (
    occupancyScore +
    getLargestEmptyRegion(board) * 12 -
    countIsolatedEmptyCells(board) * 500 +
    scoreLineSetups(board) +
    scoreFutureShapeSpace(board) -
    fullClearPenalty
  );
}

function scoreLineSetups(board) {
  let score = 0;
  let readyRows = 0;
  let readyCols = 0;

  function scoreFilledCount(filled) {
    if (filled === 7) return 700;
    if (filled === 6) return 280;
    if (filled === 5) return 100;
    if (filled === 4) return 25;

    return 0;
  }

  for (const row of board) {
    const filled = row.filter((value) => value === 1).length;

    score += scoreFilledCount(filled);

    if (filled >= 6) {
      readyRows++;
    }
  }

  for (let col = 0; col < BOARD_SIZE; col++) {
    let filled = 0;

    for (let row = 0; row < BOARD_SIZE; row++) {
      filled += board[row][col];
    }

    score += scoreFilledCount(filled);

    if (filled >= 6) {
      readyCols++;
    }
  }

  if (readyRows > 0 && readyCols > 0) {
    score += 600;
  }

  return score;
}

function scoreFutureShapeSpace(board) {
  let score = 0;

  for (const futureShape of FUTURE_SURVIVAL_SHAPES) {
    const placementCount = findSpace(board, futureShape.shape).length;

    if (placementCount === 0) {
      score -= futureShape.missingPenalty;
      continue;
    }

    score += Math.min(placementCount, 8) * 75;
  }

  return score;
}

function getLargestEmptyRegion(board) {
  const visited = Array.from({ length: BOARD_SIZE }, () =>
    Array(BOARD_SIZE).fill(false),
  );

  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  let largest = 0;

  for (let startRow = 0; startRow < BOARD_SIZE; startRow++) {
    for (let startCol = 0; startCol < BOARD_SIZE; startCol++) {
      if (board[startRow][startCol] !== 0 || visited[startRow][startCol]) {
        continue;
      }

      const queue = [[startRow, startCol]];
      let queueIndex = 0;
      let size = 0;

      visited[startRow][startCol] = true;

      while (queueIndex < queue.length) {
        const [row, col] = queue[queueIndex++];

        size++;

        for (const [rowOffset, colOffset] of directions) {
          const nextRow = row + rowOffset;

          const nextCol = col + colOffset;

          if (
            nextRow < 0 ||
            nextRow >= BOARD_SIZE ||
            nextCol < 0 ||
            nextCol >= BOARD_SIZE
          ) {
            continue;
          }

          if (visited[nextRow][nextCol] || board[nextRow][nextCol] !== 0) {
            continue;
          }

          visited[nextRow][nextCol] = true;
          queue.push([nextRow, nextCol]);
        }
      }

      largest = Math.max(largest, size);
    }
  }

  return largest;
}

function countIsolatedEmptyCells(board) {
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  let isolated = 0;

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] !== 0) {
        continue;
      }

      const hasEmptyNeighbor = directions.some(([rowOffset, colOffset]) => {
        const nextRow = row + rowOffset;

        const nextCol = col + colOffset;

        return (
          nextRow >= 0 &&
          nextRow < BOARD_SIZE &&
          nextCol >= 0 &&
          nextCol < BOARD_SIZE &&
          board[nextRow][nextCol] === 0
        );
      });

      if (!hasEmptyNeighbor) {
        isolated++;
      }
    }
  }

  return isolated;
}

function trimShape(shape) {
  if (!Array.isArray(shape)) {
    return null;
  }

  const occupied = [];

  for (let row = 0; row < shape.length; row++) {
    if (!Array.isArray(shape[row])) {
      return null;
    }

    for (let col = 0; col < shape[row].length; col++) {
      if (shape[row][col] === 1) {
        occupied.push([row, col]);
      }
    }
  }

  if (occupied.length === 0) {
    return null;
  }

  const rows = occupied.map(([row]) => row);
  const cols = occupied.map(([, col]) => col);

  const minRow = Math.min(...rows);
  const maxRow = Math.max(...rows);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);

  return shape
    .slice(minRow, maxRow + 1)
    .map((row) => row.slice(minCol, maxCol + 1));
}

function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    throw new Error("Board must contain 8 rows");
  }

  for (const row of board) {
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      throw new Error("Every board row must contain 8 cells");
    }

    if (row.some((value) => value !== 0 && value !== 1)) {
      throw new Error("Board cells must be 0 or 1");
    }
  }
}

function cloneMatrix(matrix) {
  return matrix.map((row) => [...row]);
}

module.exports = {
  solveBoard,
  findSpace,
  simulatePlacement,
};
