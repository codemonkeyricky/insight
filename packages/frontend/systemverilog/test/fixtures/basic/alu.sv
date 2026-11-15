module alu #(
  parameter int WIDTH = 32,
  parameter int OPS = 4
) (
  input  logic             clk,
  input  logic [WIDTH-1:0] a,
  input  logic [WIDTH-1:0] b,
  input  pkg::opcode_e     op,
  output logic [WIDTH-1:0] y,
  output logic             zero
);

  logic [WIDTH-1:0] result;

  always_comb begin
    case (op)
      pkg::OP_ADD: result = pkg::saturate_add(a, b);
      pkg::OP_SUB: result = a - b;
      pkg::OP_MUL: result = a * b;
      default:     result = '0;
    endcase
  end

  assign y = result;
  assign zero = (result == '0);

endmodule
