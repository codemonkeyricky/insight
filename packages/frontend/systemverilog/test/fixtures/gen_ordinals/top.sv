module top;
  if (1) begin : g0
    always_ff @(posedge clk) a <= 1;
    always_ff @(posedge clk) b <= 1;
  end
  if (1) begin : g1
    always_ff @(posedge clk) c <= 1;
  end
endmodule
