package dv_pkg;
  import "DPI-C" function int c_add(input int a, input int b);
  import "DPI-C" context task c_wait(input int n);

  class dv_base;
    virtual task wait_clks();
    endtask
    function void log(string s);
    endfunction
  endclass
endpackage
