package pkg;

  typedef enum logic [1:0] {
    OP_NOP = 2'b00,
    OP_ADD = 2'b01,
    OP_SUB = 2'b10,
    OP_MUL = 2'b11
  } opcode_e;

  localparam int unsigned NUM_REGS = 16;

  function automatic logic [31:0] saturate_add(input logic [31:0] a, input logic [31:0] b);
    logic [32:0] sum;
    sum = {1'b0, a} + {1'b0, b};
    return sum[32] ? 32'hFFFF_FFFF : sum[31:0];
  endfunction

endpackage
