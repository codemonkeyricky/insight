interface bus_if (input logic clk);
  logic valid;
  task automatic wait_clks();
    @(posedge clk);
  endtask
  modport mst (input valid);
endinterface
