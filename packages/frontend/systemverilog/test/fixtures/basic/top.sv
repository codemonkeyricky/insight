`include "defs.svh"

module top (
  input  logic                  clk,
  input  logic                  rst_n,
  input  logic [`DATA_WIDTH-1:0] din,
  output logic [`DATA_WIDTH-1:0] dout
);

  import pkg::*;

  logic [`DATA_WIDTH-1:0] acc;
  logic [`DATA_WIDTH-1:0] alu_y;
  logic                   alu_zero;
  logic [`DATA_WIDTH-1:0] mem [0:(1 << `ADDR_WIDTH)-1];
  opcode_e                op_q;

  alu #(
    .WIDTH(`DATA_WIDTH)
  ) u_alu (
    .clk  (clk),
    .a    (acc),
    .b    (din),
    .op   (op_q),
    .y    (alu_y),
    .zero (alu_zero)
  );

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      acc <= '0;
    end else if (alu_zero) begin
      acc <= din;
    end else begin
      acc <= alu_y;
    end
  end

  task automatic report(input string tag);
    $display("%s: acc=%0h", tag, acc);
  endtask

  for (genvar i = 0; i < 4; i++) begin : g_lanes
    logic [`DATA_WIDTH-1:0] lane_q;
    always_ff @(posedge clk) lane_q <= din ^ i;
  end

  assign dout = acc;

  initial begin
    $readmemh("init.hex", mem);
  end

endmodule
