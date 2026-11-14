module broken_top
  import dv_pkg::*;
  #(parameter int W = 2) (
  input logic clk
);
  logic [W-1:0] q;
  always_ff @(posedge clk) q <= q + 1;
endmodule
